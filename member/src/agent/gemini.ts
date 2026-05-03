/**
 * Google Gemini provider — tool-use agent loop using the @google/genai SDK.
 */

import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai'
import type { AgentTask, Provider, RunAgentOptions, RunAgentResult, TokenUsage } from './types.ts'

const MAX_LOOP_ITERATIONS = 30
const DEFAULT_MAX_OUTPUT_TOKENS = 8192

/**
 * Sampling temperature schedule for Gemini calls.
 *
 * Why a schedule and not a single value: the @google/genai SDK does not expose
 * strict / constrained tool-call decoding for `functionDeclarations`, so the
 * model emits tool calls as plain generated tokens. Higher temperatures
 * sharply increase the rate of invalid JSON in tool arguments — particularly
 * for long string fields like `write_file.content` (markdown with backticks,
 * embedded quotes, …) — which Gemini reports as
 * `finishReason: MALFORMED_FUNCTION_CALL`.
 *
 * - First attempt is at 0 (greedy / deterministic), the most reliable setting
 *   for structured output most of the time.
 * - But retrying greedy at 0 is pointless — same input → same malformed
 *   output. So follow-up attempts ramp temperature up to perturb the sampling
 *   path until either a valid tool call lands or we give up.
 *
 * Tradeoff: file contents written by the agent are slightly more uniform /
 * less "creative" at temp 0. For a coding agent that's a good trade — we want
 * correct, stable tool calls and sensible code, not stylistic variety. The
 * higher-temp retries only kick in when the deterministic path has already
 * failed, so the average run is still effectively temp 0.
 */
const TEMPERATURE_SCHEDULE = [0, 0.3, 0.7, 1] as const

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
						text: buildKickoffPrompt(task),
					},
				],
			},
		]

		const totalUsage: TokenUsage = { input: 0, output: 0 }
		let summary: string | null = null

		for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration++) {
			throwIfAborted(abortSignal)

			let response: Awaited<ReturnType<typeof this.client.models.generateContent>> | null =
				null
			let attempt = 0
			while (true) {
				const temperature =
					TEMPERATURE_SCHEDULE[attempt] ??
					TEMPERATURE_SCHEDULE[TEMPERATURE_SCHEDULE.length - 1]!
				const r = await this.client.models.generateContent({
					model: this.model,
					contents: history,
					config: {
						systemInstruction: systemPrompt,
						tools: [{ functionDeclarations: sdkTools }],
						maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
						temperature,
					},
				})
				if (r.usageMetadata) {
					totalUsage.input += r.usageMetadata.promptTokenCount ?? 0
					totalUsage.output += r.usageMetadata.candidatesTokenCount ?? 0
					await onEvent({ kind: 'usage', payload: { ...totalUsage } })
				}
				const fr = r.candidates?.[0]?.finishReason
				if (fr === 'MALFORMED_FUNCTION_CALL' && attempt < TEMPERATURE_SCHEDULE.length - 1) {
					attempt++
					await onEvent({
						kind: 'log',
						payload: {
							message: 'gemini returned MALFORMED_FUNCTION_CALL, retrying',
							attempt,
							next_temperature: TEMPERATURE_SCHEDULE[attempt],
						},
					})
					continue
				}
				response = r
				break
			}

			const candidate = response.candidates?.[0]
			if (!candidate) {
				summary = describeEmptyResponse(response, null)
				break
			}

			const modelParts: Part[] = candidate.content?.parts ?? []
			const modelContent: Content = { role: 'model', parts: [...modelParts] }
			history.push(modelContent)

			const finishReason = candidate.finishReason
			const functionCalls = response.functionCalls

			if (!functionCalls || functionCalls.length === 0) {
				// No tool calls — extract text and finish.
				const text = extractText(modelParts)
				summary = text ?? describeEmptyResponse(response, candidate)
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

function buildKickoffPrompt(task: AgentTask): string {
	const { title, description, kind, prUrl, repo, metadata } = task
	const issueNumber = readIssueNumber(metadata)

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
			`3. Post your review with one of:`,
			`   - \`gh pr review ${prUrl} --approve -b "<comment>"\``,
			`   - \`gh pr review ${prUrl} --request-changes -b "<comment>"\``,
			`   - \`gh pr review ${prUrl} --comment -b "<comment>"\``,
			``,
			`If \`--approve\` (or \`--request-changes\`) fails because GitHub forbids`,
			`acting on your own pull request, fall back to \`gh pr review --comment\``,
			`with the same body and still report your verdict accurately in the JSON`,
			`block — the household tracks approvals internally.`,
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

	if (kind === 'estimate') {
		const ackLines =
			repo && issueNumber !== null
				? [
						``,
						`## Acknowledge the issue first`,
						`Before doing anything else, post an 👀 reaction on the source issue:`,
						`\`gh api -X POST /repos/${repo}/issues/${issueNumber}/reactions -f content=eyes\``,
						`Best-effort — log and continue if it fails.`,
					]
				: []
		return [
			`# Estimate: ${title}`,
			``,
			`## Task description`,
			description.trim(),
			...ackLines,
			``,
			`## Instructions`,
			`Estimate the size of this task. **Do not modify any files** — this is a sizing pass only; an `,
			`\`implement\` task will run afterwards to do the actual work.`,
			``,
			`Use \`bash\` (e.g. \`ls\`, \`rg\`, \`cat\`) and \`read_file\` only as needed to understand the scope. Stop calling tools as soon as you have enough signal — extensive exploration burns tokens for no benefit on a short estimate.`,
			``,
			`Sizing scale: S (≲1h focused work, single small file), M (a few files, straightforward), L (multi-file refactor or non-trivial logic), XL (cross-cutting changes or significant new functionality).`,
			``,
			`Return your answer as a final message ending with **a single JSON line** on its own (no code fence):`,
			`{"size":"S|M|L|XL","blockers":["short reason a human must unblock", "..."]}`,
			``,
			`\`blockers\` is an array of strings; use \`[]\` if you have no blockers. Examples of legitimate blockers: missing credentials, ambiguous spec, breaking change requiring approval. **Do not add blockers for things you can simply do yourself in the implement task.**`,
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
		description.trim(),
		``,
		`Apply this change by editing files in the working tree. Use \`read_file\` / \`bash\` to find what to change, \`write_file\` to apply each edit (full new contents per file), and \`bash\` to run any sanity checks the repo offers (tests, build, linter). When the files on disk look right, briefly summarize what you did and stop calling tools.`,
	].join('\n')
}

function readIssueNumber(metadata: Record<string, unknown> | null): number | null {
	if (!metadata) return null
	const v = metadata['github_issue_number']
	return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function extractText(parts: Part[]): string | null {
	const texts = parts.filter((p) => typeof p.text === 'string').map((p) => p.text as string)
	return texts.length > 0 ? texts.join('\n').trim() : null
}

/**
 * Build a diagnostic summary when Gemini returns no text and no tool calls.
 * The default stringification is unhelpful ("agent finished without text"),
 * so we surface every signal the API gave us — finish reason, prompt-feedback
 * block reason, safety ratings, candidate count — so the failure event can
 * actually be acted on.
 */
function describeEmptyResponse(
	response: { candidates?: unknown[]; promptFeedback?: unknown },
	candidate: { finishReason?: unknown; finishMessage?: unknown; safetyRatings?: unknown } | null,
): string {
	const lines: string[] = ['(agent returned no text and no tool calls)']
	if (candidate?.finishReason) {
		lines.push(`finishReason: ${String(candidate.finishReason)}`)
	}
	if (candidate?.finishMessage) {
		lines.push(`finishMessage: ${String(candidate.finishMessage)}`)
	}
	const blocked = (response.promptFeedback as { blockReason?: unknown } | undefined)?.blockReason
	if (blocked) lines.push(`promptFeedback.blockReason: ${String(blocked)}`)
	const safety = candidate?.safetyRatings
	if (Array.isArray(safety) && safety.length > 0) {
		const triggered = safety
			.map((r) => r as { category?: string; probability?: string; blocked?: boolean })
			.filter((r) => r.blocked || (r.probability && r.probability !== 'NEGLIGIBLE'))
			.map(
				(r) =>
					`${r.category ?? '?'}=${r.probability ?? '?'}${r.blocked ? '(blocked)' : ''}`,
			)
		if (triggered.length > 0) lines.push(`safety: ${triggered.join(', ')}`)
	}
	const candidateCount = response.candidates?.length ?? 0
	if (candidateCount === 0) lines.push('candidates: 0')
	return lines.join(' · ')
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		const err = new Error('aborted')
		err.name = 'AbortError'
		throw err
	}
}
