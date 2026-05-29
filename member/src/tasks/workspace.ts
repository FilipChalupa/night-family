/**
 * Workspace manager — one bare clone cached per repo, one git worktree
 * per task. Layout:
 *
 *   <WORKSPACE_DIR>/
 *     .cache/<owner>/<repo>.git/      bare clones (per-Member)
 *     <task-id>/                      task working tree + events.ndjson
 *
 * The cache dir is per-Member-container (no concurrent locks needed).
 * Stale caches GC after CACHE_TTL_MS without use.
 */

import { existsSync } from 'node:fs'
import { mkdir, rm, stat, utimes, writeFile, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Logger } from 'pino'
import { isTransientGhError, retryWithBackoff } from '../retry.ts'
import { authenticatedRemoteUrl, gh, git, GitError } from './git.ts'

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * `git rebase` reported a conflict the runner can't resolve without an
 * LLM round-trip. v1 of the rebase TaskKind fails fast and surfaces the
 * git stderr; humans (or a future LLM rescue path) take it from there.
 */
export class RebaseConflictError extends Error {
	constructor(readonly gitStderr: string) {
		super('rebase_conflict')
		this.name = 'RebaseConflictError'
	}
}

/**
 * Couldn't even start the rebase — typically because the head ref was
 * deleted between the webhook firing and the rebase task being claimed.
 */
export class RebaseSetupError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'RebaseSetupError'
	}
}

export interface WorkspaceOpts {
	taskId: string
	/**
	 * Task title — used as the descriptive ("soft") suffix of the branch
	 * name for human readability. The unique prefix (`pr/night/<8 hex>`) is
	 * what the household uses to look the task back up, so this part is
	 * free-form and may be empty.
	 */
	taskTitle: string
	repo: string // org/name
	githubToken: string
	workspaceDir: string
	logger: Logger
}

export class Workspace {
	/**
	 * The remote-side SHA of {@link branch} at the moment we fetched it
	 * before any local mutations. Set only by {@link createForRebase};
	 * `null` for the implement-task path. {@link pushWithLease} uses it
	 * as the lease target, so a concurrent push to the head branch
	 * between fetch and push is detected and rejected.
	 */
	private leaseShaBeforeRebase: string | null = null

	private constructor(
		readonly taskId: string,
		readonly repo: string,
		readonly path: string,
		readonly cachePath: string,
		readonly branch: string,
		readonly baseBranch: string,
		private readonly token: string,
		private readonly logger: Logger,
	) {}

	static async create(opts: WorkspaceOpts): Promise<Workspace> {
		const { taskId, taskTitle, repo, githubToken, workspaceDir, logger } = opts
		const cachePath = join(workspaceDir, '.cache', repo + '.git')
		await ensureBareClone(cachePath, repo, githubToken, logger)
		await touch(cachePath)

		const baseBranch = await detectDefaultBranch(cachePath)
		const branch = buildBranchName(taskId, taskTitle)
		const taskPath = join(workspaceDir, taskId, 'work')

		await rm(taskPath, { recursive: true, force: true })
		await mkdir(dirname(taskPath), { recursive: true })

		// Idempotency for retries: a previous run for the same taskId may have
		// left a registered worktree and the branch ref behind. `worktree prune`
		// drops dangling worktree records (the dir was rm'd above), and `-B`
		// resets the branch if it already exists instead of erroring.
		try {
			await git(['worktree', 'prune'], { cwd: cachePath })
		} catch {
			/* best-effort */
		}

		// Create branch from latest base, attached to a worktree. We can't use
		// `origin/<baseBranch>` here: `git clone --bare` defaults to refspec
		// `+refs/heads/*:refs/heads/*`, so the bare cache has no
		// `refs/remotes/origin/*` — only `refs/heads/*`. The fetch above also
		// lands on `refs/heads/<baseBranch>`.
		await git(['fetch', 'origin', `+${baseBranch}:${baseBranch}`], { cwd: cachePath })
		await git(['worktree', 'add', '-B', branch, taskPath, baseBranch], {
			cwd: cachePath,
		})

		// Configure committer identity for this worktree.
		await git(['config', 'user.name', 'Night Family'], { cwd: taskPath })
		await git(['config', 'user.email', 'noreply+night@local'], { cwd: taskPath })

		logger.info({ taskId, repo, branch, baseBranch }, 'workspace ready')

		return new Workspace(
			taskId,
			repo,
			taskPath,
			cachePath,
			branch,
			baseBranch,
			githubToken,
			logger,
		)
	}

	/**
	 * Workspace tailored for a `rebase` task: skips the fresh-from-base
	 * branch creation that {@link create} does, and instead checks out
	 * the existing head branch (whatever the PR points at). Fetches both
	 * head and base; captures the head's pre-rebase SHA so
	 * {@link pushWithLease} can lease against it.
	 *
	 * Throws {@link RebaseSetupError} if the head branch isn't reachable
	 * — that's a soft fail (PR might have been deleted between webhook
	 * and dispatch); the caller should mark the task failed.
	 *
	 * TODO(rebase): integration test against a real git remote. The unit
	 * tests cover the Household-side enqueue + dispatch routing, but this
	 * fetch/worktree/rebase/push sequence is only validated end-to-end on
	 * a live PR. A test harness with a local bare-repo fixture (or a
	 * GitHub fixture repo) would catch regressions before they hit prod.
	 */
	static async createForRebase(opts: {
		taskId: string
		repo: string
		headRef: string
		baseRef: string
		githubToken: string
		workspaceDir: string
		logger: Logger
	}): Promise<Workspace> {
		const { taskId, repo, headRef, baseRef, githubToken, workspaceDir, logger } = opts
		const cachePath = join(workspaceDir, '.cache', repo + '.git')
		await ensureBareClone(cachePath, repo, githubToken, logger)
		await touch(cachePath)

		// Fetch both refs into local heads. `+ref:ref` forces overwrite if a
		// stale local head is in the way (e.g. a previous rebase task ran for
		// the same head and its result is now what `origin/ref` actually
		// holds, but our local heads still reflect the pre-rebase state).
		try {
			await git(['fetch', 'origin', `+${headRef}:${headRef}`, `+${baseRef}:${baseRef}`], {
				cwd: cachePath,
				timeoutMs: 120_000,
			})
		} catch (err) {
			throw new RebaseSetupError(
				`failed to fetch ${headRef} or ${baseRef}: ${(err as Error).message}`,
			)
		}

		const taskPath = join(workspaceDir, taskId, 'work')
		await rm(taskPath, { recursive: true, force: true })
		await mkdir(dirname(taskPath), { recursive: true })

		try {
			await git(['worktree', 'prune'], { cwd: cachePath })
		} catch {
			/* best-effort */
		}

		// `-B` resets the local branch label to point at the freshly fetched
		// head ref, even if a stale label from a prior task is in the way.
		await git(['worktree', 'add', '-B', headRef, taskPath, headRef], { cwd: cachePath })

		await git(['config', 'user.name', 'Night Family'], { cwd: taskPath })
		await git(['config', 'user.email', 'noreply+night@local'], { cwd: taskPath })

		const ws = new Workspace(
			taskId,
			repo,
			taskPath,
			cachePath,
			headRef,
			baseRef,
			githubToken,
			logger,
		)
		ws.leaseShaBeforeRebase = (await git(['rev-parse', 'HEAD'], { cwd: taskPath })).trim()

		logger.info(
			{ taskId, repo, headRef, baseRef, leaseSha: ws.leaseShaBeforeRebase.slice(0, 8) },
			'rebase workspace ready',
		)
		return ws
	}

	/**
	 * How many commits the base branch is ahead of the current head — i.e.
	 * how far behind base the PR branch has fallen. Both refs were fetched
	 * into local heads by {@link createForRebase}, so this is a local
	 * object-db walk with no network round-trip.
	 *
	 * `0` means the head already contains every base commit, so a rebase
	 * would rewrite nothing. Callers use that to skip the force-push
	 * entirely — no CI re-run, no dismissed reviews — which makes it safe
	 * for the Household to over-enqueue rebase tasks (push webhook + the
	 * periodic freshness sweep both fire optimistically).
	 */
	async countBehindBase(): Promise<number> {
		const out = await git(['rev-list', '--count', `HEAD..${this.baseBranch}`], {
			cwd: this.path,
		})
		return Number(out.trim()) || 0
	}

	/**
	 * Run `git rebase <baseBranch>` in this workspace. Aborts the rebase
	 * on conflict and throws {@link RebaseConflictError}; the caller is
	 * expected to fail the task and surface the message to humans (who
	 * will resolve the conflict by hand).
	 */
	async rebaseOntoBase(): Promise<{ rewroteCommits: boolean; newSha: string }> {
		const beforeSha = (await git(['rev-parse', 'HEAD'], { cwd: this.path })).trim()
		try {
			await git(['rebase', this.baseBranch], { cwd: this.path, timeoutMs: 120_000 })
		} catch (err) {
			// Best-effort cleanup so the worktree isn't left in a half-rebased state.
			try {
				await git(['rebase', '--abort'], { cwd: this.path })
			} catch {
				/* ignore */
			}
			const stderr = err instanceof GitError ? err.stderr : ''
			throw new RebaseConflictError(stderr.slice(0, 2000) || (err as Error).message)
		}
		const afterSha = (await git(['rev-parse', 'HEAD'], { cwd: this.path })).trim()
		return { rewroteCommits: beforeSha !== afterSha, newSha: afterSha }
	}

	/**
	 * Push the rebased branch with `--force-with-lease=<branch>:<sha>`,
	 * where `<sha>` is the head ref's value at fetch time (captured by
	 * {@link createForRebase}). Bare clones don't track
	 * `refs/remotes/origin/*`, so we lease explicitly against the
	 * pre-rebase head SHA. If somebody pushed to the branch between
	 * fetch and push, the lease fails — exactly what we want.
	 */
	async pushWithLease(): Promise<void> {
		if (this.leaseShaBeforeRebase === null) {
			throw new Error('pushWithLease: workspace was not set up via createForRebase')
		}
		const remote = authenticatedRemoteUrl(this.repo, this.token)
		const lease = `--force-with-lease=${this.branch}:${this.leaseShaBeforeRebase}`
		try {
			await retryWithBackoff(
				() =>
					git(['push', lease, remote, `${this.branch}:${this.branch}`], {
						cwd: this.path,
						timeoutMs: 120_000,
					}),
				{
					// Lease violations ("stale info" / "non-fast-forward") are
					// the entire point of using a lease — retrying would just
					// race the same way. Only transport-level errors retry.
					isTransientError: (err) =>
						err instanceof GitError && isTransientGhError(err.stderr),
					onRetry: (attempt, delayMs) => {
						this.logger.info(
							{ attempt, delayMs },
							'pushWithLease transient failure, retrying',
						)
					},
				},
			)
		} catch (err) {
			if (err instanceof GitError) {
				this.logger.warn(
					{ stderr: err.stderr.slice(0, 400) },
					'push --force-with-lease failed',
				)
			}
			throw err
		}
	}

	async commit(message: string, agentName: string): Promise<{ sha: string } | null> {
		const status = await git(['status', '--porcelain'], { cwd: this.path })
		if (status.trim().length === 0) return null

		await git(['add', '-A'], { cwd: this.path })
		const fullMessage =
			message.trim() + '\n\n' + `Co-Authored-By: Night <${agentName}> <noreply+night@local>\n`
		await git(['commit', '-m', fullMessage], { cwd: this.path })
		const sha = (await git(['rev-parse', 'HEAD'], { cwd: this.path })).trim()
		this.logger.info({ sha: sha.slice(0, 8), message: message.split('\n')[0] }, 'commit')
		return { sha }
	}

	async push(): Promise<void> {
		const remote = authenticatedRemoteUrl(this.repo, this.token)
		// `--force` not `--force-with-lease`: the bare cache only fetches the
		// base branch (workspace.create), so we have no remote-tracking ref for
		// `pr/night/...` to lease against. Without a lease the push errors as
		// `(stale info)`. The branch is owned exclusively by this task — it
		// matches `pr/night/<task-id>-…` and no other agent runs the same task
		// concurrently — so plain `--force` is safe here.
		//
		// Retried on transient errors (HTTP 5xx, secondary rate limit, network
		// blips) so a 2-second GitHub hiccup doesn't fail an otherwise good
		// task. Non-transient git errors (auth, validation) still propagate on
		// the first try.
		try {
			await retryWithBackoff(
				() =>
					git(['push', '--force', remote, `${this.branch}:${this.branch}`], {
						cwd: this.path,
						timeoutMs: 120_000,
					}),
				{
					isTransientError: (err) =>
						err instanceof GitError && isTransientGhError(err.stderr),
					onRetry: (attempt, delayMs) => {
						this.logger.info({ attempt, delayMs }, 'push transient failure, retrying')
					},
				},
			)
		} catch (err) {
			if (err instanceof GitError) {
				this.logger.warn({ stderr: err.stderr.slice(0, 400) }, 'push failed')
			}
			throw err
		}
	}

	/**
	 * Create / update a draft PR via `gh`. Idempotent: if a PR for this branch
	 * already exists, edit its body via the REST API and return its URL;
	 * otherwise open a fresh draft.
	 */
	async upsertDraftPr(opts: { title: string; body: string }): Promise<{ url: string } | null> {
		// Step 1: discover whether a PR already exists for this branch.
		let existing: { url: string; number: number } | null = null
		try {
			const raw = await gh(
				['pr', 'list', '--head', this.branch, '--json', 'url,number', '--limit', '1'],
				{ cwd: this.path, token: this.token },
			)
			const parsed = JSON.parse(raw) as Array<{ url: string; number: number }>
			existing = parsed[0] ?? null
		} catch (err) {
			this.logger.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				'gh pr list failed (will try create)',
			)
		}

		// Step 2: if a PR exists, update title/body via the REST API.
		// We deliberately avoid `gh pr edit` because it goes through GraphQL and
		// queries deprecated fields like `projectCards`, which can fail the whole
		// command with `GraphQL: Projects (classic) is being deprecated …` even
		// when the underlying update would have succeeded. The REST PATCH endpoint
		// touches only the fields we actually care about.
		if (existing) {
			try {
				await gh(
					[
						'api',
						'-X',
						'PATCH',
						`repos/${this.repo}/pulls/${existing.number}`,
						'-f',
						`title=${opts.title}`,
						'-f',
						`body=${opts.body}`,
					],
					{ cwd: this.path, token: this.token },
				)
			} catch (err) {
				// Non-fatal — the PR is already there with whatever body it had,
				// so we can still return success and let the caller proceed.
				if (err instanceof GitError) {
					this.logger.warn({ stderr: err.stderr.slice(0, 400) }, 'gh pr edit failed')
				} else {
					this.logger.warn(
						{ err: err instanceof Error ? err.message : String(err) },
						'gh pr edit failed',
					)
				}
			}
			return { url: existing.url }
		}

		// Step 3: no existing PR — create one.
		try {
			const url = (
				await gh(
					[
						'pr',
						'create',
						'--draft',
						'--head',
						this.branch,
						'--base',
						this.baseBranch,
						'--title',
						opts.title,
						'--body',
						opts.body,
					],
					{ cwd: this.path, token: this.token },
				)
			).trim()
			return { url }
		} catch (err) {
			if (err instanceof GitError) {
				this.logger.warn({ stderr: err.stderr.slice(0, 400) }, 'gh pr create failed')
			}
			return null
		}
	}

	/**
	 * Mark the draft PR as ready for review.
	 */
	async markPrReady(prUrl: string): Promise<void> {
		try {
			await gh(['pr', 'ready', prUrl], { cwd: this.path, token: this.token })
		} catch (err) {
			this.logger.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				'gh pr ready failed',
			)
		}
	}

	/**
	 * Read project-specific instructions from the target repo. Looks for
	 * AGENTS.md / CLAUDE.md / .cursor/rules/*.md / .github/copilot-instructions.md
	 * (first found wins).
	 */
	async readProjectInstructions(): Promise<string | null> {
		const candidates = [
			'AGENTS.md',
			'CLAUDE.md',
			'.github/copilot-instructions.md',
			'.cursor/rules/index.md',
		]
		for (const rel of candidates) {
			const p = join(this.path, rel)
			if (existsSync(p)) {
				try {
					return await readFile(p, 'utf8')
				} catch {
					/* ignore */
				}
			}
		}
		// Glob-ish: any .cursor/rules/*.md
		const cursorDir = join(this.path, '.cursor', 'rules')
		if (existsSync(cursorDir)) {
			try {
				const files = (await readdir(cursorDir)).filter((f) => f.endsWith('.md')).sort()
				if (files[0]) {
					return await readFile(join(cursorDir, files[0]), 'utf8')
				}
			} catch {
				/* ignore */
			}
		}
		return null
	}

	/**
	 * Drop the worktree (but keep the bare clone cache).
	 */
	async cleanup(): Promise<void> {
		try {
			await git(['worktree', 'remove', '--force', this.path], { cwd: this.cachePath })
		} catch (err) {
			if (err instanceof GitError) {
				this.logger.warn({ stderr: err.stderr.slice(0, 200) }, 'worktree remove failed')
			}
		}
		await rm(this.path, { recursive: true, force: true })
	}
}

async function ensureBareClone(
	path: string,
	repo: string,
	token: string,
	logger: Logger,
): Promise<void> {
	if (existsSync(join(path, 'config'))) {
		// Existing cache; refresh remote URL (token may have rotated) and fetch.
		await git(['remote', 'set-url', 'origin', authenticatedRemoteUrl(repo, token)], {
			cwd: path,
		})
		try {
			await git(['fetch', '--prune', 'origin'], { cwd: path, timeoutMs: 120_000 })
		} catch (err) {
			logger.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				'fetch failed, continuing with cached refs',
			)
		}
		return
	}
	await mkdir(dirname(path), { recursive: true })
	logger.info({ repo, path }, 'bare clone (fresh)')
	await git(['clone', '--bare', authenticatedRemoteUrl(repo, token), path], {
		cwd: dirname(path),
		timeoutMs: 300_000,
	})
	await writeFile(join(path, '.night-cache'), 'managed-by-night-agents\n', 'utf8')
}

async function detectDefaultBranch(cachePath: string): Promise<string> {
	try {
		const symbolic = (await git(['symbolic-ref', '--short', 'HEAD'], { cwd: cachePath })).trim()
		if (symbolic) return symbolic
	} catch {
		// fall through
	}
	const remoteShow = await git(['remote', 'show', 'origin'], { cwd: cachePath })
	const m = remoteShow.match(/HEAD branch:\s*(\S+)/)
	if (m && m[1]) return m[1]
	return 'main'
}

function slug(s: string): string {
	return (
		s
			.normalize('NFD')
			.replace(/\p{M}+/gu, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'task'
	)
}

/**
 * Branch layout: `pr/night/<8 hex>-<title-slug>`.
 *
 * The `<8 hex>` prefix is the load-bearing part — the household parses it
 * out of incoming PR webhooks (see github/handlers/pulls.ts) to map a PR
 * back to its task, and `Workspace.create` reuses the same name on retry
 * so the existing branch is reset rather than duplicated. The title slug
 * is purely cosmetic; if the title is missing or unslugifiable we fall
 * back to the literal `task`, which matches the legacy default.
 */
export function buildBranchName(taskId: string, taskTitle: string): string {
	return `pr/night/${taskId.slice(0, 8)}-${slug(taskTitle)}`
}

async function touch(path: string): Promise<void> {
	const now = new Date()
	try {
		await utimes(path, now, now)
	} catch {
		/* ignore */
	}
}

/**
 * Per-task scratch / event-buffer dirs. Survive on disk after a task
 * finishes so a recent failure stays inspectable, but reaped after this
 * window so they don't accumulate forever. Worktrees themselves are
 * removed eagerly by `Workspace.cleanup()` at task end; this catches the
 * leftover events.ndjson + scratch/, plus any worktree that escaped
 * cleanup (e.g. process killed mid-run).
 */
export const TASK_DIR_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Delete cache dirs unused for > CACHE_TTL_MS. Call once at Member startup.
 */
export async function gcStaleCaches(workspaceDir: string, logger: Logger): Promise<void> {
	const cacheRoot = join(workspaceDir, '.cache')
	if (!existsSync(cacheRoot)) return
	const cutoff = Date.now() - CACHE_TTL_MS
	const owners = await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])
	for (const ownerEntry of owners) {
		if (!ownerEntry.isDirectory()) continue
		const ownerPath = join(cacheRoot, ownerEntry.name)
		const repos = await readdir(ownerPath, { withFileTypes: true }).catch(() => [])
		for (const repoEntry of repos) {
			if (!repoEntry.isDirectory()) continue
			const repoPath = join(ownerPath, repoEntry.name)
			try {
				const st = await stat(repoPath)
				if (st.mtimeMs < cutoff) {
					await rm(repoPath, { recursive: true, force: true })
					logger.info({ path: repoPath }, 'gc stale repo cache')
				}
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Delete per-task dirs (`<workspaceDir>/<taskId>/`) older than
 * {@link TASK_DIR_TTL_MS}. Each contains the worktree (if not already
 * cleaned), `events.ndjson`, and `scratch/`. Call once at Member startup
 * alongside {@link gcStaleCaches}.
 *
 * Detection is by name shape: `<taskId>` is a UUID, so we skip anything
 * that doesn't match. `.cache` is filtered explicitly because it sits at
 * the same level and has its own GC.
 */
export async function gcStaleTaskDirs(workspaceDir: string, logger: Logger): Promise<void> {
	if (!existsSync(workspaceDir)) return
	const cutoff = Date.now() - TASK_DIR_TTL_MS
	const entries = await readdir(workspaceDir, { withFileTypes: true }).catch(() => [])
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		if (entry.name === '.cache' || entry.name.startsWith('.')) continue
		// Loose UUID-shape check: 32+ hex digits with separators. Avoids
		// nuking any operator-managed sibling dir that found its way into
		// the workspace volume.
		if (!/^[0-9a-f-]{32,}$/i.test(entry.name)) continue
		const taskPath = join(workspaceDir, entry.name)
		try {
			const st = await stat(taskPath)
			if (st.mtimeMs < cutoff) {
				await rm(taskPath, { recursive: true, force: true })
				logger.info({ path: taskPath }, 'gc stale task dir')
			}
		} catch {
			/* ignore */
		}
	}
}
