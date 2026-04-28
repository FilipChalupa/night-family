/**
 * Google Gemini provider — tool-use agent loop using the @google/genai SDK.
 */

import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai'
import type { Provider, RunAgentOptions, RunAgentResult, TokenUsage } from './types.ts'

const MAX_LOOP_ITERATIONS = 30
const DEFAULT_MAX_OUTPUT_TOKENS = 8192

export class GeminiProvider implements Provider {
	readonly name = 'gemini' as const
	readonly model: string
	private readonly client: GoogleGenAI

	constructor(opts: { apiKey: string; model: string }) {
		this.model = opts.model
		this.client = new GoogleGenAI({ apiKey: opts.apiKey })
	}

	async runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
		const { task, tools, systemPrompt, onEvent, abortSignal } = opts

		const sdkTools: FunctionDeclaration[] = tools.map((t) => ({
			name: t.name,
			description: t.description,
			parametersJsonSchema: t.inputSchema as Record<string, unknown>,
		}))
		const toolByName = new Map(tools.map((t) => [t.name, t]))

		// Build conversation history. Gemini expects alternating user/model turns.
		const history: Content[] = [
			{
				role: 'user',
				parts: [
					{
						text: buildKickoffPrompt(
							task.title,
							task.description,
							task.kind,
							task.prUrl,
						),
					},
				],
			},
		]

		const totalUsage: TokenUsage = { input: 0, output: 0 }
		let summary: string | null = null

		for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration++) {
			throwIfAborted(abortSignal)

			const response = await this.client.models.generateContent({
				model: this.model,
				contents: history,
				config: {
					systemInstruction: systemPrompt,
					tools: [{ functionDeclarations: sdkTools }],
					maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
				},
			})

			if (response.usageMetadata) {
				totalUsage.input += response.usageMetadata.promptTokenCount ?? 0
				totalUsage.output += response.usageMetadata.candidatesTokenCount ?? 0
				await onEvent({ kind: 'usage', payload: { ...totalUsage } })
			}

			const candidate = response.candidates?.[0]
			if (!candidate) {
				summary = '(no candidates returned)'
				break
			}

			const modelParts: Part[] = candidate.content?.parts ?? []
			const modelContent: Content = { role: 'model', parts: [...modelParts] }
			history.push(modelContent)

			const finishReason = candidate.finishReason
			const functionCalls = response.functionCalls

			if (!functionCalls || functionCalls.length === 0) {
				// No tool calls — extract text and finish.
				summary = extractText(modelParts) ?? '(agent finished without text)'
				break
			}

			if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
				summary = `(agent stopped: ${finishReason})`
				break
			}

			// Execute all tool calls and collect responses.
			const responseParts: Part[] = []
			for (const fc of functionCalls) {
				throwIfAborted(abortSignal)

				const toolName = fc.name ?? ''
				await onEvent({ kind: 'tool_call', payload: { tool: toolName, input: fc.args } })

				const tool = toolByName.get(toolName)
				let resultText: string
				let isError = false

				if (!tool) {
					resultText = `unknown tool: ${toolName}`
					isError = true
				} else {
					try {
						const r = await tool.run(fc.args as Record<string, unknown>)
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

				responseParts.push({
					functionResponse: {
						name: toolName,
						response: { output: resultText, is_error: isError },
					},
				})
			}

			// Gemini expects function responses as a 'user' turn.
			history.push({ role: 'user', parts: responseParts })
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

function extractText(parts: Part[]): string | null {
	const texts = parts.filter((p) => typeof p.text === 'string').map((p) => p.text as string)
	return texts.length > 0 ? texts.join('\n').trim() : null
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		const err = new Error('aborted')
		err.name = 'AbortError'
		throw err
	}
}
