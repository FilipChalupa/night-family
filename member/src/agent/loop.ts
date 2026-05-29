/**
 * Shared agent-loop runtime helpers used by every provider adapter.
 *
 * Each provider drives its own SDK-specific message loop (Anthropic content
 * blocks, OpenAI chat messages, Gemini Content/Part), but the two pieces that
 * are genuinely identical across all of them — the abort check and the
 * run-one-tool-and-emit-events step — live here so the loops can't drift apart.
 */

import type { AgentEvent, ToolDefinition } from './types.ts'

/** Max chars of tool output forwarded in a `log` event to Household. */
const TOOL_LOG_MAX_CHARS = 800

/**
 * Throw a well-formed `AbortError` if the signal has fired. The runner keys off
 * `err.name === 'AbortError'` to tell a cancellation apart from a crash, so the
 * name matters — a bare `Error` would be misreported as a task failure.
 */
export function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		const err = new Error('aborted')
		err.name = 'AbortError'
		throw err
	}
}

/** Result of running one tool call: the text to feed back, and the error flag. */
export interface ToolCallOutcome {
	output: string
	isError: boolean
}

/**
 * Run a single tool call and emit the standard `tool_call` (before) and `log`
 * (after) agent events. Centralises the unknown-tool fallback and the
 * throw-to-string error handling that every provider repeated verbatim; the
 * caller only has to shape the returned outcome into its SDK's tool-result
 * message.
 */
export async function executeToolCall(
	toolByName: Map<string, ToolDefinition>,
	name: string,
	input: unknown,
	onEvent: (event: AgentEvent) => void | Promise<void>,
): Promise<ToolCallOutcome> {
	await onEvent({ kind: 'tool_call', payload: { tool: name, input } })

	const tool = toolByName.get(name)
	let output: string
	let isError: boolean
	if (!tool) {
		output = `unknown tool: ${name}`
		isError = true
	} else {
		try {
			const result = await tool.run(input)
			output = result.output
			isError = result.isError ?? false
		} catch (err) {
			output = err instanceof Error ? err.message : String(err)
			isError = true
		}
	}

	await onEvent({
		kind: 'log',
		payload: { tool: name, output: output.slice(0, TOOL_LOG_MAX_CHARS), isError },
	})

	return { output, isError }
}
