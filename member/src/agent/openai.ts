/**
 * OpenAI provider — tool-use agent loop using the openai SDK (chat completions).
 */

import OpenAI from 'openai'
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
				content: buildKickoffPrompt(task.title, task.description, task.kind, task.prUrl),
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

				await onEvent({ kind: 'tool_call', payload: { tool: toolName, input: parsedInput } })

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

function buildKickoffPrompt(
	title: string,
	description: string,
	kind: string,
	prUrl: string | null,
): string {
	if (kind === 'review' && prUrl) {
		return [
			`# Code Review: ${title}`,
			``,
			`PR URL: ${prUrl}`,
			``,
			`## Task description`,
			description.trim(),
			``,
			`## Instructions`,
			`Review the pull request at the URL above. Use the bash tool to:`,
			`1. Run \`gh pr diff ${prUrl}\` to read the changes.`,
			`2. Run \`gh pr view ${prUrl}\` to read the PR description.`,
			`3. Post your review with \`gh pr review ${prUrl} --approve/-b/--request-changes\`.`,
			``,
			`End your summary with a JSON block on its own line:`,
			`{"verdict":"approved"} or {"verdict":"changes_requested"} or {"verdict":"commented"}`,
		].join('\n')
	}

	if (kind === 'respond' && prUrl) {
		return [
			`# PR Thread Response: ${title}`,
			``,
			`PR URL: ${prUrl}`,
			``,
			`## Context`,
			description.trim(),
			``,
			`## Instructions`,
			`A reviewer left comments on the pull request. Use the bash tool to:`,
			`1. Run \`gh pr view ${prUrl} --comments\` to read the PR thread.`,
			`2. Run \`gh pr diff ${prUrl}\` if you need to see the code context.`,
			`3. Respond using: \`gh pr comment ${prUrl} --body "<your response>"\``,
			`When done, summarize the responses you posted.`,
		].join('\n')
	}

	if (kind === 'summarize') {
		return [
			`# Summary Task: ${title}`,
			``,
			`## Description`,
			description.trim(),
			``,
			`## Instructions`,
			`Generate the requested summary. You may use the bash tool to query GitHub`,
			`(e.g. \`gh pr list\`, \`gh issue list\`). Return a well-formatted Markdown document.`,
		].join('\n')
	}

	return [
		`# Task: ${title}`,
		``,
		`Kind: ${kind}`,
		``,
		`## Description`,
		description.trim(),
		``,
		`Use the available tools to inspect the workspace, make the changes, and run`,
		`whatever verification (tests, build) you can. When done, summarize what you changed.`,
	].join('\n')
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		const err = new Error('aborted')
		err.name = 'AbortError'
		throw err
	}
}
