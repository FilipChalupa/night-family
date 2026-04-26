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
import { AnthropicProvider, buildSystemPrompt } from '../agent/anthropic.ts'
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
import { EventBuffer, eventFilePath } from './eventBuffer.ts'
import { Workspace } from './workspace.ts'

export interface AssignedTaskInput {
	taskId: string
	kind: TaskKind
	title: string
	description: string
	repo: string | null
	githubToken: string
	repoUrl: string
}

export interface TaskRunnerDeps {
	memberName: string
	memberId: string
	provider: Provider
	limits: MemberLimits
	dailyUsage: { tokensToday(): number; record(usage: TokenUsage): void }
	workspaceDir: string
	logger: Logger
	wsSend: (msg: MsgEvent) => boolean
	stubMode: boolean
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

		// Hard wallclock limit (per plan §4).
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

		try {
			await emit('log', {
				message: 'task started',
				kind: task.kind,
				title: task.title,
				repo: task.repo,
				stub: this.deps.stubMode,
			})

			let workspace: Workspace | null = null
			if (task.repo && task.kind !== 'estimate' && task.kind !== 'summarize') {
				workspace = await Workspace.create({
					taskId: task.taskId,
					repo: task.repo,
					githubToken: task.githubToken,
					workspaceDir: this.deps.workspaceDir,
					logger: this.deps.logger.child({ component: 'workspace' }),
				})
				await emit('log', { message: 'workspace ready', branch: workspace.branch })
			} else {
				// Tasks without a repo (estimate, summarize) still need a scratch dir
				// for any file ops the agent might do.
				const scratch = join(this.deps.workspaceDir, task.taskId, 'scratch')
				await mkdir(scratch, { recursive: true })
			}

			const projectInstructions =
				workspace !== null ? await workspace.readProjectInstructions() : null

			const tools: ToolDefinition[] = createDefaultTools({
				root: workspace?.path ?? join(this.deps.workspaceDir, task.taskId, 'scratch'),
			})

			const systemPrompt = buildSystemPrompt({
				memberName: this.deps.memberName,
				repo: task.repo,
				projectInstructions,
			})

			const agentTask: AgentTask = {
				taskId: task.taskId,
				kind: task.kind,
				title: task.title,
				description: task.description,
				repo: task.repo,
				systemPromptAddition: projectInstructions,
			}

			const onAgentEvent = async (event: AgentEvent): Promise<void> => {
				if (event.kind === 'usage') {
					const u = event.payload as TokenUsage
					this.enforceLimits(u)
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
					// PR creation lands in M4 — just record what we'd open.
					prUrl = null
				} else {
					await emit('log', { message: 'no changes to commit' })
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
		}
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
	 * Shape the wire-level `result` based on task kind. Estimate must return
	 * `{size, blockers}`; everything else returns the agent summary.
	 */
	private shapeResult(kind: TaskKind, summary: string): unknown {
		if (kind === 'estimate') {
			return parseEstimateOutput(summary)
		}
		return { summary }
	}
}

/**
 * Try to extract `{size, blockers}` from a summary string. The agent is
 * instructed to end with a JSON line; if it doesn't, we fall back to size=M.
 */
function parseEstimateOutput(summary: string): {
	size: 'S' | 'M' | 'L' | 'XL'
	blockers: string[]
} {
	const match = summary.match(/\{[\s\S]*"size"[\s\S]*\}/)
	if (match) {
		try {
			const obj = JSON.parse(match[0]) as {
				size?: string
				blockers?: string[]
			}
			if (obj.size === 'S' || obj.size === 'M' || obj.size === 'L' || obj.size === 'XL') {
				const blockers = Array.isArray(obj.blockers)
					? obj.blockers.filter((b): b is string => typeof b === 'string')
					: []
				return { size: obj.size, blockers }
			}
		} catch {
			/* fall through */
		}
	}
	return { size: 'M', blockers: [] }
}

function summarizeForCommit(title: string, summary: string): string {
	const firstLine = summary.split('\n')[0] ?? ''
	const subject = firstLine.length > 0 && firstLine.length < 72 ? firstLine : title
	return subject + '\n\n' + summary
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
	throw new Error(`Provider ${opts.provider} is not yet implemented (M6).`)
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
