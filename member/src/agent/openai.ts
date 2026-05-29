/**
 * OpenAI provider — tool-use agent loop using the openai SDK (Responses API).
 *
 * Uses the Responses API rather than Chat Completions so that reasoning /
 * codex models (`gpt-5`, `gpt-5-codex`, o-series) work as well as the older
 * chat models. The Responses API is a superset: classic models like
 * `gpt-4.1` run through the same path unchanged.
 *
 * Multi-turn shape: every iteration we append the model's full `output`
 * (message + reasoning + function-call items) back into `input`, then append
 * one `function_call_output` per tool call. Echoing the reasoning items back
 * is what lets reasoning models preserve their chain-of-thought across tool
 * calls — dropping them degrades quality on `gpt-5-codex`.
 */

import OpenAI from 'openai'
import { executeToolCall, throwIfAborted } from './loop.ts'
import { buildKickoffPrompt } from './prompts.ts'
import type { Provider, RunAgentOptions, RunAgentResult, TokenUsage } from './types.ts'

const DEFAULT_MAX_LOOP_ITERATIONS = 30
/**
 * Output-token cap per response. For reasoning models this budget is shared
 * between hidden reasoning tokens and the visible answer, so it's set well
 * above the old Chat-Completions value to avoid truncating mid-thought.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16384

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
		const maxIterations = opts.maxIterations ?? DEFAULT_MAX_LOOP_ITERATIONS

		// Responses API function tools are flat — name/description/parameters
		// at the top level, not nested under a `function` key like Chat
		// Completions.
		const sdkTools: OpenAI.Responses.Tool[] = tools.map((t) => ({
			type: 'function' as const,
			name: t.name,
			description: t.description,
			parameters: t.inputSchema as Record<string, unknown>,
			strict: false,
		}))
		const toolByName = new Map(tools.map((t) => [t.name, t]))

		const input: OpenAI.Responses.ResponseInputItem[] = [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: buildKickoffPrompt(task) },
		]

		const totalUsage: TokenUsage = { input: 0, output: 0 }
		let summary: string | null = null

		for (let iteration = 0; iteration < maxIterations; iteration++) {
			throwIfAborted(abortSignal)

			const response = await this.client.responses.create({
				model: this.model,
				input,
				tools: sdkTools,
				max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
			})

			if (response.usage) {
				totalUsage.input += response.usage.input_tokens
				totalUsage.output += response.usage.output_tokens
				await onEvent({ kind: 'usage', payload: { ...totalUsage } })
			}

			// Echo the full output (message + reasoning + function calls) back
			// into the running input for the next turn.
			input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]))

			const functionCalls = response.output.filter(
				(item): item is OpenAI.Responses.ResponseFunctionToolCall =>
					item.type === 'function_call',
			)

			if (functionCalls.length === 0) {
				summary = response.output_text || '(agent finished without text)'
				break
			}

			// Execute tool calls.
			for (const fc of functionCalls) {
				throwIfAborted(abortSignal)

				let parsedInput: unknown
				try {
					parsedInput = JSON.parse(fc.arguments)
				} catch {
					parsedInput = {}
				}

				const { output } = await executeToolCall(toolByName, fc.name, parsedInput, onEvent)

				input.push({
					type: 'function_call_output',
					call_id: fc.call_id,
					output,
				})
			}
		}

		if (summary === null) {
			summary = `(agent loop hit ${maxIterations} iterations without completing)`
		}

		return { summary, usage: totalUsage }
	}
}
