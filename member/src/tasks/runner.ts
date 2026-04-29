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
import { EventBuffer, eventFilePath } from './eventBuffer.ts'
import { Workspace } from './workspace.ts'

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

			// Tasks that don't need a git worktree — agent works in a scratch dir.
			const isReview = task.kind === 'review'
			const isNoWorkspace =
				isReview ||
				task.kind === 'respond' ||
				task.kind === 'estimate' ||
				task.kind === 'summarize'

			let workspace: Workspace | null = null
			if (task.repo && !isNoWorkspace) {
				workspace = await Workspace.create({
					taskId: task.taskId,
					repo: task.repo,
					githubToken: task.githubToken,
					workspaceDir: this.deps.workspaceDir,
					logger: this.deps.logger.child({ component: 'workspace' }),
				})
				await emit('log', { message: 'workspace ready', branch: workspace.branch })
			} else {
				// estimate, summarize, review — just need a scratch dir for any file ops.
				const scratch = join(this.deps.workspaceDir, task.taskId, 'scratch')
				await mkdir(scratch, { recursive: true })
			}

			const projectInstructions =
				workspace !== null ? await workspace.readProjectInstructions() : null

			const tools: ToolDefinition[] = createDefaultTools({
				root: workspace?.path ?? join(this.deps.workspaceDir, task.taskId, 'scratch'),
				// Pass token so `gh pr review` / `gh pr diff` work inside bash tool.
				githubToken: task.githubToken || undefined,
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
				prUrl: task.prUrl,
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

			// Review / respond / summarize — no commit/push/PR, return immediately.
			if (isNoWorkspace) {
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
							memberName: this.deps.memberName,
							provider: this.deps.provider.name,
							model: this.deps.provider.model,
							taskId: task.taskId,
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
							if (task.kind !== 'estimate') {
								await workspace.markPrReady(opened.url)
								await emit('log', {
									message: 'PR ready for review',
									url: opened.url,
								})
							}
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
		if (kind === 'review') {
			return parseReviewOutput(summary)
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

/**
 * Extract `{verdict, summary}` from a review summary. Agent is instructed to
 * end with a JSON block; falls back to `commented` if not parseable.
 */
function parseReviewOutput(summary: string): {
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

function summarizeForCommit(title: string, summary: string): string {
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

function prTitleFor(title: string): string {
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
	memberName: string
	provider: string
	model: string
	taskId: string
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
	lines.push('')

	lines.push('---')
	lines.push(
		`🤖 Authored by Night Family member \`${opts.memberName}\` · task \`${opts.taskId.slice(0, 8)}\``,
	)
	return lines.join('\n')
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
