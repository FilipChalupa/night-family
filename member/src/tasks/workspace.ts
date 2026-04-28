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
import { authenticatedRemoteUrl, gh, git, GitError } from './git.ts'

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface WorkspaceOpts {
	taskId: string
	repo: string // org/name
	githubToken: string
	workspaceDir: string
	logger: Logger
}

export class Workspace {
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
		const { taskId, repo, githubToken, workspaceDir, logger } = opts
		const cachePath = join(workspaceDir, '.cache', repo + '.git')
		await ensureBareClone(cachePath, repo, githubToken, logger)
		await touch(cachePath)

		const baseBranch = await detectDefaultBranch(cachePath)
		const branch = `pr/night/${taskId.slice(0, 8)}-${slug(taskId)}`
		const taskPath = join(workspaceDir, taskId, 'work')

		await rm(taskPath, { recursive: true, force: true })
		await mkdir(dirname(taskPath), { recursive: true })

		// Create branch from latest base, attached to a worktree.
		await git(['fetch', 'origin', baseBranch], { cwd: cachePath })
		await git(['worktree', 'add', '-b', branch, taskPath, `origin/${baseBranch}`], {
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
		try {
			await git(['push', remote, `${this.branch}:${this.branch}`, '--force-with-lease'], {
				cwd: this.path,
				timeoutMs: 120_000,
			})
		} catch (err) {
			if (err instanceof GitError) {
				this.logger.warn({ stderr: err.stderr.slice(0, 400) }, 'push failed')
			}
			throw err
		}
	}

	/**
	 * Create / update a draft PR via `gh`. Idempotent: if a PR for this branch
	 * already exists, edit its body; otherwise open a fresh draft.
	 */
	async upsertDraftPr(opts: { title: string; body: string }): Promise<{ url: string } | null> {
		try {
			const existing = await gh(
				['pr', 'list', '--head', this.branch, '--json', 'url,number', '--limit', '1'],
				{ cwd: this.path, token: this.token },
			)
			const parsed = JSON.parse(existing) as Array<{ url: string; number: number }>
			if (parsed[0]) {
				await gh(
					[
						'pr',
						'edit',
						String(parsed[0].number),
						'--body',
						opts.body,
						'--title',
						opts.title,
					],
					{ cwd: this.path, token: this.token },
				)
				return { url: parsed[0].url }
			}
		} catch (err) {
			this.logger.warn(
				{ err: err instanceof Error ? err.message : String(err) },
				'gh pr list failed (will try create)',
			)
		}

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
	 * (first found wins, per plan §4).
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
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'task'
	)
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
