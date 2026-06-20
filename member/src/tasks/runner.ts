/**
 * TaskRunner — runs a single dispatched task end-to-end:
 *
 *   1. Set up workspace (clone or worktree) when the task targets a repo.
 *   2. Append a `log` event recording the agent kickoff.
 *   3. Invoke the provider's agent loop with the workspace's tools.
 *   4. After the agent finishes, commit any remaining changes and push.
 *   5. Report task.completed with the agent's summary, or task.failed.
 *
 * Events are written to a per-task ndjson buffer first; if the WS is up they
 * also stream to Household. On reconnect the buffer is replayed.
 */

import type { EventKind, MsgEvent, TaskKind } from '@night/shared'
import { redactJson } from '@night/shared'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { AnthropicProvider } from '../agent/anthropic.ts'
import { buildSystemPrompt } from '../agent/prompts.ts'
import { GeminiProvider } from '../agent/gemini.ts'
import { OpenAIProvider } from '../agent/openai.ts'
import { StubProvider } from '../agent/stub.ts'
import {
	QuotaExceededError,
	TaskTimeoutError,
	type AgentEvent,
	type AgentTask,
	type MemberLimits,
	type Provider,
	type ToolDefinition,
	type TokenUsage,
} from '../agent/types.ts'
import { createDefaultTools } from '../agent/tools.ts'
import { appendAttribution, type AttributionInputs } from '@night/shared'
import { EventBuffer, eventFilePath } from './eventBuffer.ts'
import { gh, GitError } from './git.ts'
import { checkoutBranch, RebaseConflictError, RebaseSetupError, Workspace } from './workspace.ts'
import { annotatePrWithPreview, PreviewServer, type RunningPreview } from './preview.ts'
import { toHttpScheme, type PreviewPort } from '@night/shared'

export interface AssignedTaskInput {
	taskId: string
	kind: TaskKind
	title: string
	description: string
	repo: string | null
	prUrl: string | null
	githubToken: string
	repoUrl: string
	metadata: Record<string, unknown> | null
}

export interface TaskRunnerDeps {
	memberName: string
	memberId: string
	/**
	 * Public-facing URL of the Household — same value the Member uses to
	 * reach the WS endpoint, but referenced here only to embed deep links
	 * (member/task pages) inside Markdown emitted to GitHub PRs.
	 */
	householdUrl: string
	provider: Provider
	limits: MemberLimits
	dailyUsage: { tokensToday(): number; record(usage: TokenUsage): void }
	workspaceDir: string
	logger: Logger
	wsSend: (msg: MsgEvent) => boolean
	stubMode: boolean
	preview: {
		ports: ReadonlyArray<{ port: number; label: string }>
		readyTimeoutMs: number
		publishMode: 'local' | 'household'
	}
}

export interface TaskOutcome {
	type: 'completed' | 'failed'
	result?: unknown
	prUrl?: string
	reason?: string
}

export class TaskRunner {
	private abortController: AbortController | null = null
	private currentTaskId: string | null = null

	constructor(private readonly deps: TaskRunnerDeps) {}

	get activeTaskId(): string | null {
		return this.currentTaskId
	}

	cancel(reason: string): void {
		const ac = this.abortController
		if (ac && !ac.signal.aborted) {
			this.deps.logger.info({ reason }, 'aborting task')
			ac.abort(new Error(reason))
		}
	}

	async run(task: AssignedTaskInput): Promise<TaskOutcome> {
		this.currentTaskId = task.taskId
		const ac = new AbortController()
		this.abortController = ac

		// Hard wallclock limit.
		const wallclockTimer = setTimeout(() => {
			ac.abort(new TaskTimeoutError(this.deps.limits.maxTaskDurationMinutes))
		}, this.deps.limits.maxTaskDurationMinutes * 60_000)
		wallclockTimer.unref()

		const buffer = new EventBuffer(
			task.taskId,
			eventFilePath(this.deps.workspaceDir, task.taskId),
		)
		await buffer.load()

		const emit = async (kind: EventKind, payload: unknown): Promise<void> => {
			const safe = redactJson(payload)
			const ev = await buffer.append(kind, safe)
			const wireMsg: MsgEvent = {
				type: 'event',
				task_id: ev.taskId,
				seq: ev.seq,
				ts: ev.ts,
				kind: ev.kind,
				payload: ev.payload,
			}
			const sent = this.deps.wsSend(wireMsg)
			if (sent) buffer.markSent(ev.seq)
		}

		// Hoisted out of `try` so the `finally` block can drop the worktree
		// regardless of completion or failure path. Per-task event buffer
		// and scratch dir survive — they get reaped by `gcStaleTaskDirs` on
		// next startup so a recent failure is still inspectable.
		let workspaceForCleanup: Workspace | null = null

		try {
			await emit('log', {
				message: 'task started',
				kind: task.kind,
				title: task.title,
				repo: task.repo,
				stub: this.deps.stubMode,
			})

			// `rebase` short-circuits the LLM agent loop entirely: it's a
			// deterministic git operation. Run it inline and return.
			if (task.kind === 'rebase') {
				return await this.runRebaseTask(task, emit)
			}

			// `preview` is also non-agent: it runs the project's dev server on a
			// branch and stays alive until the task is cancelled. Run it inline.
			if (task.kind === 'preview') {
				return await this.runPreview(task, emit, ac.signal)
			}

			// Smoke-test the GitHub token against the originating issue by
			// posting an "eyes" reaction. Failure here almost always means
			// the PAT can't write to the repo, so abort before we spend any
			// agent budget instead of failing at comment / PR-open time.
			// Applies to issue-driven tasks (triage, implement); PR-driven
			// tasks (review, respond, summarize) skip this probe.
			const reactsOnIssue = task.kind === 'implement' || task.kind === 'triage'
			if (reactsOnIssue && task.repo && task.githubToken) {
				const issue = githubIssueRef(task.metadata)
				if (issue?.number !== undefined && issue?.number !== null) {
					try {
						await this.postEyesReaction({
							repo: task.repo,
							issueNumber: issue.number,
							token: task.githubToken,
						})
						await emit('log', {
							message: 'eyes reaction posted',
							repo: task.repo,
							issue: issue.number,
						})
					} catch (err) {
						const stderr =
							err instanceof GitError ? err.stderr.slice(0, 500) : undefined
						return await this.fail(emit, null, 'reaction_failed', {
							message:
								'failed to add eyes reaction on the originating issue — the GitHub token likely lacks write access to this repo',
							repo: task.repo,
							issue: issue.number,
							...(stderr ? { stderr } : {}),
						})
					}
				}
			}

			// Tasks that don't need a git worktree — agent works in a scratch dir.
			// Triage is NOT here: it clones the repo so the agent can read the
			// code to judge how clear/large the issue is, but it still produces
			// no commit/PR (see `producesPr` below) — its only output is one
			// issue comment.
			const isReview = task.kind === 'review'
			const isNoWorkspace = isReview || task.kind === 'respond' || task.kind === 'summarize'

			// Of the worktree tasks, only implement turns its file edits into a
			// commit + draft PR. Triage reads the tree but never writes to it, so
			// it skips the commit/push/PR path even though it has a workspace.
			const producesPr = !isNoWorkspace && task.kind !== 'triage'

			let workspace: Workspace | null = null
			if (task.repo && !isNoWorkspace) {
				workspace = await Workspace.create({
					taskId: task.taskId,
					taskTitle: task.title,
					repo: task.repo,
					githubToken: task.githubToken,
					workspaceDir: this.deps.workspaceDir,
					logger: this.deps.logger.child({ component: 'workspace' }),
				})
				workspaceForCleanup = workspace
				await emit('log', { message: 'workspace ready', branch: workspace.branch })
			} else {
				// summarize, review, respond — just need a scratch dir
				// for any file ops the agent does while reading context.
				const scratch = join(this.deps.workspaceDir, task.taskId, 'scratch')
				await mkdir(scratch, { recursive: true })
			}

			const projectInstructions =
				workspace !== null ? await workspace.readProjectInstructions() : null

			const attribution = {
				memberName: this.deps.memberName,
				memberId: this.deps.memberId,
				taskId: task.taskId,
				householdUrl: this.deps.householdUrl,
			}

			const tools: ToolDefinition[] = createDefaultTools({
				root: workspace?.path ?? join(this.deps.workspaceDir, task.taskId, 'scratch'),
				// Pass token so read-only `gh` commands and the post_* tools
				// authenticate without an interactive login.
				githubToken: task.githubToken || undefined,
				attribution,
				// Triage produces exactly one comment (question or plan); lock the
				// tool after the first success so a stuck loop can't spam the
				// issue thread the way it could spam reviews before we capped
				// post_pr_review.
				oneShotIssueComment: task.kind === 'triage',
				// Read-mostly kinds get a tight per-command timeout so a slow
				// whole-repo search fails fast instead of eating a 5-minute hang.
				bashTimeoutMs: bashTimeoutMsForKind(task.kind),
			})

			const systemPrompt = buildSystemPrompt({
				memberName: this.deps.memberName,
				repo: task.repo,
				projectInstructions,
				tokenBudgetHint: formatTokenBudgetHint(
					this.deps.limits,
					this.deps.dailyUsage.tokensToday(),
				),
			})

			const agentTask: AgentTask = {
				taskId: task.taskId,
				kind: task.kind,
				title: task.title,
				description: task.description,
				repo: task.repo,
				prUrl: task.prUrl,
				metadata: task.metadata ?? null,
				systemPromptAddition: projectInstructions,
			}

			const stats = new RunStats()
			const onAgentEvent = async (event: AgentEvent): Promise<void> => {
				if (event.kind === 'usage') {
					const u = event.payload as TokenUsage
					this.enforceLimits(u)
					stats.usage = u
				}
				if (event.kind === 'tool_call') {
					const toolName = (event.payload as { tool?: string }).tool
					if (toolName) stats.recordToolCall(toolName)
				}
				if (event.kind === 'file_edited') {
					const path = (event.payload as { path?: string }).path
					if (path) stats.recordFileEdit(path)
				}
				await emit(event.kind as EventKind, event.payload)
			}

			let providerResult
			try {
				providerResult = await this.deps.provider.runAgent({
					task: agentTask,
					tools,
					systemPrompt,
					onEvent: onAgentEvent,
					abortSignal: ac.signal,
					maxIterations: maxIterationsForKind(task.kind),
				})
			} catch (err) {
				if (err instanceof QuotaExceededError) {
					return await this.fail(emit, workspace, 'quota_exceeded', {
						scope: err.scope,
						used: err.used,
						limit: err.limit,
					})
				}
				if (err instanceof TaskTimeoutError) {
					return await this.fail(emit, workspace, 'timeout_exceeded', {
						minutes: err.minutes,
					})
				}
				if ((err as Error).name === 'AbortError') {
					return await this.fail(emit, workspace, 'cancelled', {
						message: (err as Error).message,
					})
				}
				return await this.fail(emit, workspace, 'agent_error', {
					message: (err as Error).message,
				})
			}

			this.deps.dailyUsage.record(providerResult.usage)

			// Review / respond / summarize / triage — no commit/push/PR, return
			// immediately. Triage had a cloned worktree to read the code, but its
			// only output is the issue comment it already posted; the workspace is
			// dropped in the `finally` block below.
			if (!producesPr) {
				await emit('log', { message: 'task complete', summary: providerResult.summary })
				return {
					type: 'completed',
					result: this.shapeResult(task.kind, providerResult.summary),
				}
			}

			let prUrl: string | null = null
			if (workspace) {
				const commit = await workspace.commit(
					summarizeForCommit(task.title, providerResult.summary),
					this.deps.memberName,
				)
				if (commit) {
					await emit('commit', { sha: commit.sha, branch: workspace.branch })
					try {
						await workspace.push()
						await emit('log', { message: 'pushed', branch: workspace.branch })
					} catch (err) {
						await emit('log', {
							message: 'push failed',
							error: (err as Error).message,
						})
						return await this.fail(emit, workspace, 'push_failed', {
							message: (err as Error).message,
						})
					}

					if (task.githubToken) {
						const description = buildPrDescription({
							title: task.title,
							summary: providerResult.summary,
							attribution,
							provider: this.deps.provider.name,
							model: this.deps.provider.model,
							stats,
							issue: githubIssueRef(task.metadata),
						})
						const opened = await workspace.upsertDraftPr({
							title: prTitleFor(task.title),
							body: description,
						})
						if (opened) {
							prUrl = opened.url
							await emit('log', { message: 'draft PR opened', url: opened.url })
							await workspace.markPrReady(opened.url)
							await emit('log', {
								message: 'PR ready for review',
								url: opened.url,
							})
						} else {
							await emit('log', { message: 'PR open skipped (gh failed)' })
						}
					} else {
						await emit('log', { message: 'PR skipped (no GitHub token)' })
					}
				} else {
					await emit('log', {
						message: 'no changes to commit',
						agent_summary: providerResult.summary,
					})
					if (task.kind === 'implement') {
						return await this.fail(emit, workspace, 'no_changes', {
							message: 'agent did not modify any files',
							agent_summary: providerResult.summary,
						})
					}
				}
			}

			await emit('log', { message: 'task complete', summary: providerResult.summary })

			return {
				type: 'completed',
				result: this.shapeResult(task.kind, providerResult.summary),
				...(prUrl ? { prUrl } : {}),
			}
		} catch (err) {
			return await this.fail(null, null, 'unhandled', {
				message: (err as Error).message,
			})
		} finally {
			clearTimeout(wallclockTimer)
			this.abortController = null
			this.currentTaskId = null
			// Drop the worktree to reclaim disk. Bare clone cache survives
			// (warm for the next task on this repo). Cleanup is best-effort:
			// a transient `git worktree remove` failure can't fail an
			// already-completed task.
			if (workspaceForCleanup) {
				try {
					await workspaceForCleanup.cleanup()
				} catch (err) {
					this.deps.logger.warn(
						{ err: (err as Error).message },
						'workspace cleanup failed (non-fatal)',
					)
				}
			}
		}
	}

	/**
	 * Deterministic rebase path — no LLM. Reads `head_ref` / `base_ref`
	 * out of the task metadata, sets up a fresh worktree on the head
	 * branch, runs `git rebase`, and pushes with lease. On conflict
	 * fails fast with a `rebase_conflict` reason so humans can resolve
	 * by hand. (Future enhancement: hand off to the LLM with the conflict
	 * context as a fallback.)
	 */
	private async runRebaseTask(
		task: AssignedTaskInput,
		emit: (kind: EventKind, payload: unknown) => Promise<void>,
	): Promise<TaskOutcome> {
		if (!task.repo) {
			return await this.fail(emit, null, 'rebase_missing_repo', {})
		}
		const meta = task.metadata ?? {}
		const headRef = typeof meta['head_ref'] === 'string' ? meta['head_ref'] : null
		const baseRef = typeof meta['base_ref'] === 'string' ? meta['base_ref'] : null
		if (!headRef || !baseRef) {
			return await this.fail(emit, null, 'rebase_missing_metadata', {
				head_ref: headRef,
				base_ref: baseRef,
			})
		}

		let workspace: Workspace
		try {
			workspace = await Workspace.createForRebase({
				taskId: task.taskId,
				repo: task.repo,
				headRef,
				baseRef,
				githubToken: task.githubToken,
				workspaceDir: this.deps.workspaceDir,
				logger: this.deps.logger.child({ component: 'workspace' }),
			})
			await emit('log', { message: 'rebase workspace ready', headRef, baseRef })
		} catch (err) {
			if (err instanceof RebaseSetupError) {
				return await this.fail(emit, null, 'rebase_setup_failed', {
					message: err.message,
				})
			}
			throw err
		}

		// Drop the worktree on every exit path — same disk-reclaim story as
		// implement tasks. Best-effort; logs but doesn't fail the outcome.
		const cleanupAfter = async (outcome: TaskOutcome): Promise<TaskOutcome> => {
			try {
				await workspace.cleanup()
			} catch (err) {
				this.deps.logger.warn(
					{ err: (err as Error).message },
					'rebase workspace cleanup failed (non-fatal)',
				)
			}
			return outcome
		}

		// Idempotency guard. The Household enqueues rebase tasks optimistically
		// (on every base-branch push and on the periodic freshness sweep) without
		// knowing whether the PR is actually behind. If the head already contains
		// every base commit there is nothing to do — completing here avoids a
		// pointless force-push that would re-trigger CI and dismiss approvals.
		const behind = await workspace.countBehindBase()
		if (behind === 0) {
			await emit('rebase', { outcome: 'up-to-date', headRef, baseRef })
			return await cleanupAfter({
				type: 'completed',
				result: { rebased: false, upToDate: true },
				...(task.prUrl ? { prUrl: task.prUrl } : {}),
			})
		}

		let rebaseResult
		try {
			rebaseResult = await workspace.rebaseOntoBase()
		} catch (err) {
			if (err instanceof RebaseConflictError) {
				// TODO(rebase): LLM rescue path. v1 fails fast and lets a human
				// resolve; eventually we'd hand the conflict context (paths +
				// markers) to the agent loop and let it produce a resolution
				// commit before retrying the push.
				await emit('rebase', {
					outcome: 'conflict',
					stderr: err.gitStderr.slice(0, 1000),
				})
				return await cleanupAfter(
					await this.fail(emit, workspace, 'rebase_conflict', {
						stderr: err.gitStderr.slice(0, 1000),
					}),
				)
			}
			return await cleanupAfter(
				await this.fail(emit, workspace, 'rebase_failed', {
					message: (err as Error).message,
				}),
			)
		}

		await emit('rebase', {
			outcome: 'rebased',
			rewroteCommits: rebaseResult.rewroteCommits,
			newSha: rebaseResult.newSha,
			headRef,
			baseRef,
		})

		// TODO(rebase): post-rebase repo sanity-checks. Today we trust the
		// project's CI to catch breakage; ideally the runner would best-effort
		// invoke `npm test` / lint / build before pushing and bail (or warn
		// loudly) if the rebase silently broke things on top of green main.
		try {
			await workspace.pushWithLease()
			await emit('log', {
				message: 'rebase push complete',
				headRef,
				newSha: rebaseResult.newSha,
			})
		} catch (err) {
			return await cleanupAfter(
				await this.fail(emit, workspace, 'rebase_push_failed', {
					message: (err as Error).message,
				}),
			)
		}

		return await cleanupAfter({
			type: 'completed',
			result: {
				rebased: true,
				rewroteCommits: rebaseResult.rewroteCommits,
				newSha: rebaseResult.newSha,
			},
			...(task.prUrl ? { prUrl: task.prUrl } : {}),
		})
	}

	/**
	 * Preview path — no LLM. Check out the requested branch, start its dev
	 * server, report the URL (and write it into the branch's PR, if any), then
	 * hold the server open until the task is cancelled or the wallclock limit
	 * fires. Teardown stops the server and removes the worktree.
	 *
	 * The branch to preview comes from `task.metadata.branch` (or `.ref`); a
	 * preview always targets a repo.
	 */
	private async runPreview(
		task: AssignedTaskInput,
		emit: (kind: EventKind, payload: unknown) => Promise<void>,
		signal: AbortSignal,
	): Promise<TaskOutcome> {
		if (!task.repo) {
			return await this.fail(emit, null, 'preview_no_repo', {
				message: 'preview tasks require a repo',
			})
		}
		const ref = previewRef(task.metadata)
		if (!ref) {
			return await this.fail(emit, null, 'preview_no_branch', {
				message: 'preview tasks require metadata.branch (or metadata.ref)',
			})
		}

		const checkout = await checkoutBranch({
			taskId: task.taskId,
			repo: task.repo,
			ref,
			githubToken: task.githubToken,
			workspaceDir: this.deps.workspaceDir,
			logger: this.deps.logger.child({ component: 'preview-checkout' }),
		})
		await emit('log', { message: 'preview checkout ready', ref, sha: checkout.sha })

		const previewLogger = this.deps.logger.child({ component: 'preview' })
		let preview: RunningPreview | null = null
		let annotatedPr = false
		try {
			const portCfg = this.deps.preview.ports
			const primaryCfg = portCfg[0]!
			preview = await PreviewServer.start({
				cwd: checkout.path,
				logger: previewLogger,
				port: primaryCfg.port,
				readyTimeoutMs: this.deps.preview.readyTimeoutMs,
				// Dev servers are chatty (HMR etc.) — keep their output in the
				// Member log, not the Household event stream.
				onLog: (line) => previewLogger.debug({ component: 'preview' }, line),
			})

			// A preview exposes a *list* of ports (the primary dev server plus any
			// extra configured ones, e.g. an API). `target` is where each listens
			// on this host; `url` is what we show (Household-domain link in
			// `household` mode, the local URL otherwise). Household stores the
			// list and redirects each public URL to its target. Only the primary
			// is health-checked (PreviewServer waited for it); extras are
			// advertised as configured.
			const startedPreview = preview
			const ports: PreviewPort[] = portCfg.map((cfg, i) => {
				const isPrimary = i === 0
				const target = isPrimary ? startedPreview.url : `http://localhost:${cfg.port}`
				return {
					port: cfg.port,
					label: cfg.label,
					target,
					url: this.previewPublicUrl(task.taskId, target, cfg.port, isPrimary),
				}
			})
			const primary = ports[0]!
			await emit('log', {
				message: 'preview ready',
				ref,
				sha: checkout.sha,
				ports,
				// Primary port mirrored at top level for event-log readability and
				// tolerance of any older reader.
				localUrl: primary.target,
				url: primary.url,
			})

			// Record where it's running in the PR opened for this branch (if any).
			if (task.githubToken) {
				const prUrl = await annotatePrWithPreview(
					{
						cwd: checkout.path,
						githubToken: task.githubToken,
						repo: task.repo,
						ref,
						memberName: this.deps.memberName,
						status: 'running',
						ports: ports.map((p) => ({ label: p.label, url: p.url })),
						sha: checkout.sha,
					},
					previewLogger,
				)
				if (prUrl) {
					annotatedPr = true
					await emit('log', { message: 'preview annotated PR', url: prUrl })
				}
			}

			// Hold the preview open until cancelled / wallclock-aborted.
			await waitForAbort(signal)
			await emit('log', { message: 'preview stopping', ref })

			return {
				type: 'completed',
				result: {
					ports,
					url: primary.url,
					localUrl: primary.target,
					ref,
					sha: checkout.sha,
				},
			}
		} catch (err) {
			return await this.fail(emit, null, 'preview_failed', {
				message: (err as Error).message,
			})
		} finally {
			// Flip the PR's preview section to "stopped" before tearing down.
			if (annotatedPr && task.githubToken) {
				await annotatePrWithPreview(
					{
						cwd: checkout.path,
						githubToken: task.githubToken,
						repo: task.repo,
						ref,
						memberName: this.deps.memberName,
						status: 'stopped',
						sha: checkout.sha,
					},
					previewLogger,
				).catch(() => undefined)
			}
			await preview?.stop().catch(() => undefined)
			await checkout.cleanup().catch(() => undefined)
		}
	}

	/**
	 * Where to tell the world a preview port lives. In `household` mode this is
	 * a stable `<household>/previews/<task>` URL (the primary port) or
	 * `…/previews/<task>/<port>` (additional ports) that the Household redirects
	 * to the live server; in `local` mode it's the Member-local URL as-is.
	 */
	private previewPublicUrl(
		taskId: string,
		localUrl: string,
		port: number,
		isPrimary: boolean,
	): string {
		if (this.deps.preview.publishMode === 'household') {
			const base = toHttpScheme(this.deps.householdUrl).replace(/\/$/, '')
			const path = `${base}/previews/${encodeURIComponent(taskId)}`
			return isPrimary ? path : `${path}/${port}`
		}
		return localUrl
	}

	private enforceLimits(usage: TokenUsage): void {
		const total = usage.input + usage.output
		const taskLimit = this.deps.limits.maxTokensPerTask
		if (taskLimit !== null && total > taskLimit) {
			throw new QuotaExceededError('task', total, taskLimit)
		}
		const dayLimit = this.deps.limits.maxTokensPerDay
		if (dayLimit !== null) {
			const daily = this.deps.dailyUsage.tokensToday() + total
			if (daily > dayLimit) {
				throw new QuotaExceededError('day', daily, dayLimit)
			}
		}
	}

	/**
	 * POST `/repos/:repo/issues/:n/reactions` with `content=eyes`. Used as a
	 * cheap permissions probe before kicking off the agent — if the token
	 * can't write a reaction, it almost certainly can't push branches or
	 * open PRs either, and we'd rather fail fast.
	 */
	private async postEyesReaction(args: {
		repo: string
		issueNumber: number
		token: string
	}): Promise<void> {
		await gh(
			[
				'api',
				'-X',
				'POST',
				`/repos/${args.repo}/issues/${args.issueNumber}/reactions`,
				'-f',
				'content=eyes',
			],
			{ cwd: this.deps.workspaceDir, token: args.token, timeoutMs: 15_000 },
		)
	}

	private async fail(
		emit: ((kind: EventKind, payload: unknown) => Promise<void>) | null,
		_workspace: Workspace | null,
		reason: string,
		extra: Record<string, unknown>,
	): Promise<TaskOutcome> {
		if (emit) {
			try {
				await emit('log', { message: 'task failed', reason, ...extra })
			} catch {
				/* ignore */
			}
		}
		this.deps.logger.warn({ reason, ...extra }, 'task failed')
		return { type: 'failed', reason }
	}

	/**
	 * Shape the wire-level `result` based on task kind. Triage and review
	 * each end with a JSON line the dispatcher reads to drive follow-up
	 * decisions; everything else returns just the agent's summary string.
	 */
	private shapeResult(kind: TaskKind, summary: string): unknown {
		if (kind === 'triage') {
			return parseTriageOutput(summary)
		}
		if (kind === 'review') {
			return parseReviewOutput(summary)
		}
		return { summary }
	}
}

/**
 * Extract the triage agent's final JSON line:
 *   {"outcome":"question"}
 *   {"outcome":"plan","size":"S|M|L|XL"}
 *
 * Falls back to `outcome:'unknown'` if the agent didn't end with a
 * JSON line we can parse — the dispatcher treats that the same as a
 * question (no implement task spawned).
 */
export function parseTriageOutput(summary: string): {
	outcome: 'question' | 'plan' | 'unknown'
	size?: 'S' | 'M' | 'L' | 'XL'
} {
	const match = summary.match(/\{[\s\S]*"outcome"[\s\S]*\}/)
	if (match) {
		try {
			const obj = JSON.parse(match[0]) as { outcome?: string; size?: string }
			if (obj.outcome === 'question') return { outcome: 'question' }
			if (obj.outcome === 'plan') {
				const size =
					obj.size === 'S' || obj.size === 'M' || obj.size === 'L' || obj.size === 'XL'
						? obj.size
						: undefined
				return size ? { outcome: 'plan', size } : { outcome: 'plan' }
			}
		} catch {
			/* fall through */
		}
	}
	return { outcome: 'unknown' }
}

/**
 * Extract `{verdict, summary}` from a review summary. Agent is instructed to
 * end with a JSON block; falls back to `commented` if not parseable.
 */
export function parseReviewOutput(summary: string): {
	verdict: 'approved' | 'changes_requested' | 'commented'
	summary: string
} {
	const match = summary.match(/\{[\s\S]*"verdict"[\s\S]*\}/)
	if (match) {
		try {
			const obj = JSON.parse(match[0]) as { verdict?: string }
			if (
				obj.verdict === 'approved' ||
				obj.verdict === 'changes_requested' ||
				obj.verdict === 'commented'
			) {
				return { verdict: obj.verdict, summary }
			}
		} catch {
			/* fall through */
		}
	}
	return { verdict: 'commented', summary }
}

/**
 * Format the configured token caps as a single-line hint for the agent's
 * system prompt. Returns `null` when no caps are configured — no point
 * telling the model "you have unlimited budget", and the prompt drops the
 * whole section in that case. Numbers are quoted as approximate ("~50,000")
 * because the exact figure includes cache reads / cache creation that the
 * agent shouldn't be reasoning about precisely; ballpark is enough to pace.
 */
export function formatTokenBudgetHint(limits: MemberLimits, dailyUsedSoFar: number): string | null {
	const parts: string[] = []
	if (limits.maxTokensPerTask !== null) {
		parts.push(`~${limits.maxTokensPerTask.toLocaleString('en-US')} for this task`)
	}
	if (limits.maxTokensPerDay !== null) {
		const remaining = Math.max(0, limits.maxTokensPerDay - dailyUsedSoFar)
		parts.push(`~${remaining.toLocaleString('en-US')} remaining today`)
	}
	if (parts.length === 0) return null
	return `Token budget: ${parts.join('; ')}.`
}

/**
 * Cap on tool-loop iterations per task kind. Short tasks (review, triage,
 * respond) are read-mostly with one terminal post — they have no business
 * spinning past ~10 iterations, and a low cap fails fast on runaway loops
 * (we've shipped duplicate-review incidents because the default of 30
 * gave a stuck agent enough rope to spam GitHub before halting).
 * Implement / summarize keep the larger budget — those genuinely need
 * read-edit-verify cycles.
 */
export function maxIterationsForKind(kind: TaskKind): number {
	switch (kind) {
		case 'review':
		case 'triage':
		case 'respond':
			return 12
		default:
			return 30
	}
}

/**
 * Per-command bash timeout by task kind. The read-mostly kinds (triage,
 * review, respond, summarize) only ever `ls` / `cat` / search / run `gh`
 * read commands — nothing they do legitimately runs past a minute. A tight
 * cap there kills a runaway whole-repo `rg` / `grep` fast and hands the agent
 * a "timed out" it can still react to inside its small iteration budget,
 * instead of burning a full 5 minutes (and a whole iteration) per hang — the
 * exact failure mode that stalled triage on the Kilomayo monorepo. Implement
 * and rebase keep the generous budget: real test suites, installs, and builds
 * routinely run past a minute (see the note in `createDefaultTools`).
 */
export function bashTimeoutMsForKind(kind: TaskKind): number {
	switch (kind) {
		case 'triage':
		case 'review':
		case 'respond':
		case 'summarize':
			return 60_000
		default:
			return 5 * 60_000
	}
}

/** Branch/ref a preview task should check out, from its metadata. */
export function previewRef(metadata: Record<string, unknown> | null): string | null {
	const branch = metadata?.['branch']
	if (typeof branch === 'string' && branch.length > 0) return branch
	const ref = metadata?.['ref']
	if (typeof ref === 'string' && ref.length > 0) return ref
	return null
}

/** Resolve once the signal aborts (used to hold a preview open). */
function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true })
	})
}

export function summarizeForCommit(title: string, summary: string): string {
	const firstLine = summary.split('\n')[0] ?? ''
	const subject = firstLine.length > 0 && firstLine.length < 72 ? firstLine : title
	return subject + '\n\n' + summary
}

class RunStats {
	usage: TokenUsage = { input: 0, output: 0 }
	private readonly toolCounts = new Map<string, number>()
	private readonly editedFiles = new Set<string>()

	recordToolCall(name: string): void {
		this.toolCounts.set(name, (this.toolCounts.get(name) ?? 0) + 1)
	}
	recordFileEdit(path: string): void {
		this.editedFiles.add(path)
	}
	get toolBreakdown(): Array<{ tool: string; count: number }> {
		return [...this.toolCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([tool, count]) => ({ tool, count }))
	}
	get filesEdited(): string[] {
		return [...this.editedFiles].sort()
	}
}

export function prTitleFor(title: string): string {
	return title.slice(0, 200)
}

function githubIssueRef(
	metadata: Record<string, unknown> | null,
): { number: number | null; url: string | null } | null {
	if (!metadata) return null
	const numberRaw = metadata['github_issue_number']
	const urlRaw = metadata['github_issue_url']
	const number = typeof numberRaw === 'number' ? numberRaw : null
	const url = typeof urlRaw === 'string' ? urlRaw : null
	if (number === null && url === null) return null
	return { number, url }
}

function buildPrDescription(opts: {
	title: string
	summary: string
	attribution: AttributionInputs
	provider: string
	model: string
	stats: RunStats
	issue: { number: number | null; url: string | null } | null
}): string {
	const u = opts.stats.usage
	const totalTokens = u.input + u.output
	const tools = opts.stats.toolBreakdown
	const files = opts.stats.filesEdited

	const lines: string[] = []
	if (opts.issue?.number != null) {
		lines.push(`Closes #${opts.issue.number}`)
		lines.push('')
	}
	lines.push('## Summary')
	lines.push('')
	lines.push(opts.summary.trim())
	lines.push('')

	if (files.length > 0) {
		lines.push('## Files changed')
		lines.push('')
		for (const f of files.slice(0, 50)) lines.push(`- \`${f}\``)
		if (files.length > 50) lines.push(`- …and ${files.length - 50} more`)
		lines.push('')
	}

	if (tools.length > 0) {
		lines.push('## Tools used')
		lines.push('')
		for (const t of tools) lines.push(`- \`${t.tool}\` × ${t.count}`)
		lines.push('')
	}

	lines.push('## Stats')
	lines.push('')
	lines.push(`| metric | value |`)
	lines.push(`| --- | --- |`)
	lines.push(`| Provider | ${opts.provider} |`)
	lines.push(`| Model | \`${opts.model}\` |`)
	lines.push(`| Input tokens | ${u.input.toLocaleString()} |`)
	lines.push(`| Output tokens | ${u.output.toLocaleString()} |`)
	lines.push(`| Total tokens | ${totalTokens.toLocaleString()} |`)
	if (u.cacheRead) lines.push(`| Cache reads | ${u.cacheRead.toLocaleString()} |`)
	if (u.cacheCreation) lines.push(`| Cache writes | ${u.cacheCreation.toLocaleString()} |`)

	return appendAttribution(lines.join('\n'), opts.attribution)
}

export function createProvider(opts: {
	provider: 'anthropic' | 'gemini' | 'openai'
	model: string
	apiKey: string
	stub: boolean
}): Provider {
	if (opts.stub) {
		return new StubProvider(opts.model)
	}
	if (opts.provider === 'anthropic') {
		return new AnthropicProvider({ apiKey: opts.apiKey, model: opts.model })
	}
	if (opts.provider === 'gemini') {
		return new GeminiProvider({ apiKey: opts.apiKey, model: opts.model })
	}
	if (opts.provider === 'openai') {
		return new OpenAIProvider({ apiKey: opts.apiKey, model: opts.model })
	}
	throw new Error(`Unknown provider: ${opts.provider}`)
}

/**
 * Simple rolling-24h token usage tracker. Bounded memory — one bucket per
 * 24h window, oldest dropped when stale.
 */
export class DailyUsageTracker {
	private bucket: { startedAt: number; tokens: number } | null = null

	tokensToday(): number {
		this.maybeReset()
		return this.bucket?.tokens ?? 0
	}

	record(usage: TokenUsage): void {
		this.maybeReset()
		const total = usage.input + usage.output
		if (!this.bucket) {
			this.bucket = { startedAt: Date.now(), tokens: total }
		} else {
			this.bucket.tokens += total
		}
	}

	private maybeReset(): void {
		if (this.bucket && Date.now() - this.bucket.startedAt > 24 * 60 * 60 * 1000) {
			this.bucket = null
		}
	}
}
