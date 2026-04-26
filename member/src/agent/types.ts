/**
 * Common agent / tool / provider types shared by every provider adapter.
 * The provider sees a uniform tool interface; concrete tool implementations
 * (read_file, write_file, bash, …) live in `tools/`.
 */

import type { Provider as ProviderName, TaskKind } from '@night/shared'

export interface AgentTask {
	taskId: string
	kind: TaskKind
	title: string
	description: string
	repo: string | null
	systemPromptAddition: string | null
}

/**
 * JSON-serializable tool input/output. `output` is a string (whatever you'd
 * show to the model); `isError` flips the model into "tool errored" mode.
 */
export interface ToolResult {
	output: string
	isError?: boolean
}

export interface ToolDefinition {
	name: string
	description: string
	/** JSON Schema describing the input. */
	inputSchema: Record<string, unknown>
	run(input: unknown): Promise<ToolResult>
}

export interface TokenUsage {
	input: number
	output: number
	cacheRead?: number
	cacheCreation?: number
}

export interface AgentEvent {
	kind: 'tool_call' | 'log' | 'usage' | 'commit' | 'rebase' | 'file_edited'
	payload: unknown
}

export interface RunAgentOptions {
	task: AgentTask
	tools: ToolDefinition[]
	systemPrompt: string
	onEvent: (event: AgentEvent) => void | Promise<void>
	abortSignal: AbortSignal
}

export interface RunAgentResult {
	summary: string
	usage: TokenUsage
}

export interface Provider {
	readonly name: ProviderName
	readonly model: string
	runAgent(opts: RunAgentOptions): Promise<RunAgentResult>
}

export interface MemberLimits {
	maxTokensPerTask: number | null
	maxTokensPerDay: number | null
	maxTaskDurationMinutes: number
}

export class QuotaExceededError extends Error {
	constructor(
		readonly scope: 'task' | 'day',
		readonly used: number,
		readonly limit: number,
	) {
		super(`token quota exceeded (${scope}): ${used}/${limit}`)
		this.name = 'QuotaExceededError'
	}
}

export class TaskTimeoutError extends Error {
	constructor(readonly minutes: number) {
		super(`task wallclock limit reached: ${minutes} min`)
		this.name = 'TaskTimeoutError'
	}
}
