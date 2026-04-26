/**
 * Stub provider — used when AI_API_KEY is "fake" or for offline smoke tests.
 *
 * Behaviour: writes a marker file via the write_file tool, runs a quick git
 * status to exercise bash, then "completes" with a canned summary. Lets the
 * full Member pipeline (workspace, events, commit, push, replay) run without
 * a real LLM API call.
 */

import type { Provider, RunAgentOptions, RunAgentResult, ToolDefinition } from './types.ts'

export class StubProvider implements Provider {
	readonly name = 'anthropic'
	readonly model: string

	constructor(model: string) {
		this.model = model
	}

	async runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
		const { task, tools, onEvent, abortSignal } = opts

		const writeTool = byName(tools, 'write_file')
		const bashTool = byName(tools, 'bash')

		throwIfAborted(abortSignal)

		if (writeTool) {
			const args = {
				path: '.night-stub.md',
				content: `# Night agent (stub)\n\nTask: ${task.title}\n\n${task.description}\n`,
			}
			await onEvent({ kind: 'tool_call', payload: { tool: writeTool.name, args } })
			const result = await writeTool.run(args)
			await onEvent({
				kind: 'log',
				payload: {
					tool: writeTool.name,
					output: result.output,
					isError: result.isError ?? false,
				},
			})
		}

		throwIfAborted(abortSignal)

		if (bashTool) {
			const args = { command: 'git status --porcelain' }
			await onEvent({ kind: 'tool_call', payload: { tool: bashTool.name, args } })
			const result = await bashTool.run(args)
			await onEvent({
				kind: 'log',
				payload: {
					tool: bashTool.name,
					output: result.output,
					isError: result.isError ?? false,
				},
			})
		}

		const usage = { input: 0, output: 0 }
		await onEvent({ kind: 'usage', payload: usage })

		return {
			summary:
				`Stub agent completed task "${task.title}". Wrote .night-stub.md as a marker. ` +
				`Real LLM-driven implementation will land once an Anthropic / Gemini / OpenAI ` +
				`API key is configured.`,
			usage,
		}
	}
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
	return tools.find((t) => t.name === name)
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new Error('aborted')
	}
}
