/**
 * OpenAI provider — tool-use agent loop using the openai SDK (chat completions).
 */

import OpenAI from 'openai'
import { buildKickoffPrompt } from './prompts.ts'
import type { Provider, RunAgentOptions, RunAgentResult, TokenUsage } from './types.ts'

const MAX_LOOP_ITERATIONS = 30
const DEFAULT_MAX_TOKENS = 8192

export class OpenAIProvider implements Provider {
	readonly name = 'openai' as const
	readonly model: string
	private readonly client: OpenAI

	constructor(opts: { apiKey: string; model: string; baseURL?: string }) {
		this.model = opts.model
		this.client = new OpenAI({
			apiKey: opts.apiKey,
			...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
		})
	}

	async runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
		const { task, tools, systemPrompt, onEvent, abortSignal } = opts

		const sdkTools: OpenAI.ChatCompletionTool[] = tools.map((t) => ({
			type: 'function' as const,
			function: {
				name: t.name,
				description: t.description,
				parameters: t.inputSchema as Record<string, unknown>,
			},
		}))
		const toolByName = new Map(tools.map((t) => [t.name, t]))

		const messages: OpenAI.ChatCompletionMessageParam[] = [
			{ role: 'system', content: systemPrompt },
			{
				role: 'user',
				content: buildKickoffPrompt(task),
			},
		]

		const totalUsage: TokenUsage = { input: 0, output: 0 }
		let summary: string | null = null

		for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration++) {
			throwIfAborted(abortSignal)

			const response = await this.client.chat.completions.create({
				model: this.model,
				messages,
				tools: sdkTools,
				max_tokens: DEFAULT_MAX_TOKENS,
			})

			if (response.usage) {
				totalUsage.input += response.usage.prompt_tokens
				totalUsage.output += response.usage.completion_tokens
				await onEvent({ kind: 'usage', payload: { ...totalUsage } })
			}

			const choice = response.choices[0]
			if (!choice) {
				summary = '(no choices returned)'
				break
			}

			const assistantMessage = choice.message
			messages.push(assistantMessage)

			if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
				summary = assistantMessage.content ?? '(agent finished without text)'
				break
			}

			if (choice.finish_reason !== 'tool_calls' || !assistantMessage.tool_calls?.length) {
				summary = `(agent stopped: ${choice.finish_reason ?? 'unknown'})`
				break
			}

			// Execute tool calls.
			for (const tc of assistantMessage.tool_calls) {
				throwIfAborted(abortSignal)
				if (tc.type !== 'function') continue

				const toolName = tc.function.name
				let parsedInput: unknown
				try {
					parsedInput = JSON.parse(tc.function.arguments)
				} catch {
					parsedInput = {}
				}

				await onEvent({
					kind: 'tool_call',
					payload: { tool: toolName, input: parsedInput },
				})

				const tool = toolByName.get(toolName)
				let resultText: string
				let isError = false

				if (!tool) {
					resultText = `unknown tool: ${toolName}`
					isError = true
				} else {
					try {
						const r = await tool.run(parsedInput)
						resultText = r.output
						isError = r.isError ?? false
					} catch (err) {
						resultText = err instanceof Error ? err.message : String(err)
						isError = true
					}
				}

				await onEvent({
					kind: 'log',
					payload: { tool: toolName, output: resultText.slice(0, 800), isError },
				})

				messages.push({
					role: 'tool',
					tool_call_id: tc.id,
					content: resultText,
				})
			}
		}

		if (summary === null) {
			summary = `(agent loop hit ${MAX_LOOP_ITERATIONS} iterations without completing)`
		}

		return { summary, usage: totalUsage }
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		const err = new Error('aborted')
		err.name = 'AbortError'
		throw err
	}
}
