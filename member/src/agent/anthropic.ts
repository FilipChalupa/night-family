/**
 * Anthropic provider — Claude tool-use loop using the official SDK.
 *
 * Manual loop (over .stream() + .finalMessage()) so we have full control over
 * cancellation, streaming, redaction of intermediate results, and per-turn
 * event emission to Household.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
	AgentEvent,
	Provider,
	RunAgentOptions,
	RunAgentResult,
	ToolDefinition,
	TokenUsage,
} from './types.ts'

const MAX_LOOP_ITERATIONS = 30
const DEFAULT_MAX_TOKENS = 16_000

export class AnthropicProvider implements Provider {
	readonly name = 'anthropic'
	readonly model: string
	private readonly client: Anthropic

	constructor(opts: { apiKey: string; model: string; baseURL?: string }) {
		this.model = opts.model
		this.client = new Anthropic({
			apiKey: opts.apiKey,
			...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
		})
	}

	async runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
		const { task, tools, systemPrompt, onEvent, abortSignal } = opts

		const sdkTools: Anthropic.ToolUnion[] = tools.map((t) => ({
			name: t.name,
			description: t.description,
			input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
		}))
		const toolByName = new Map(tools.map((t) => [t.name, t]))

		const messages: Anthropic.MessageParam[] = [
			{
				role: 'user',
				content: [
					{
						type: 'text',
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

		const totalUsage: TokenUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheCreation: 0,
		}

		let summary: string | null = null

		for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration++) {
			throwIfAborted(abortSignal)

			const stream = this.client.messages.stream({
				model: this.model,
				max_tokens: DEFAULT_MAX_TOKENS,
				system: [
					{
						type: 'text',
						text: systemPrompt,
						cache_control: { type: 'ephemeral' },
					},
				],
				tools: sdkTools,
				messages,
				thinking: { type: 'adaptive' },
			})

			const message = await stream.finalMessage()

			if (message.usage) {
				totalUsage.input += message.usage.input_tokens ?? 0
				totalUsage.output += message.usage.output_tokens ?? 0
				totalUsage.cacheRead =
					(totalUsage.cacheRead ?? 0) + (message.usage.cache_read_input_tokens ?? 0)
				totalUsage.cacheCreation =
					(totalUsage.cacheCreation ?? 0) +
					(message.usage.cache_creation_input_tokens ?? 0)
				await onEvent({ kind: 'usage', payload: { ...totalUsage } })
			}

			messages.push({ role: 'assistant', content: message.content })

			if (message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence') {
				summary = extractText(message.content) ?? '(agent finished without text)'
				break
			}

			if (message.stop_reason === 'refusal') {
				summary = '(agent refused: ' + (extractText(message.content) ?? '') + ')'
				break
			}

			if (message.stop_reason === 'pause_turn') {
				// Server-side tool hit iteration cap; resume by re-sending without changes.
				continue
			}

			if (message.stop_reason !== 'tool_use') {
				summary = `(agent stopped unexpectedly: ${message.stop_reason ?? 'unknown'})`
				break
			}

			const toolUseBlocks = message.content.filter(
				(b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
			)

			const toolResults: Anthropic.ToolResultBlockParam[] = []
			for (const block of toolUseBlocks) {
				throwIfAborted(abortSignal)

				const tool = toolByName.get(block.name)
				await onEvent({
					kind: 'tool_call',
					payload: { tool: block.name, input: block.input },
				})

				if (!tool) {
					toolResults.push({
						type: 'tool_result',
						tool_use_id: block.id,
						content: `unknown tool: ${block.name}`,
						is_error: true,
					})
					continue
				}

				let result
				try {
					result = await tool.run(block.input)
				} catch (err) {
					result = {
						output: err instanceof Error ? err.message : String(err),
						isError: true,
					}
				}

				await onEvent({
					kind: 'log',
					payload: {
						tool: block.name,
						output: result.output.slice(0, 800),
						isError: result.isError ?? false,
					},
				})

				toolResults.push({
					type: 'tool_result',
					tool_use_id: block.id,
					content: result.output.length > 0 ? result.output : '(no output)',
					...(result.isError ? { is_error: true } : {}),
				})
			}

			messages.push({ role: 'user', content: toolResults })
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
			`3. Analyse the diff for correctness, style, security, and test coverage.`,
			`4. Post your review with one of:`,
			`   - \`gh pr review ${prUrl} --approve -b "<comment>"\``,
			`   - \`gh pr review ${prUrl} --request-changes -b "<comment>"\``,
			`   - \`gh pr review ${prUrl} --comment -b "<comment>"\``,
			``,
			`When done, write a brief summary of your findings and end with a JSON block`,
			`on its own line — for example:`,
			`{"verdict":"approved"}`,
			`or`,
			`{"verdict":"changes_requested"}`,
			`or`,
			`{"verdict":"commented"}`,
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
			`3. Respond to the reviewer's comments using:`,
			`   \`gh pr comment ${prUrl} --body "<your response>"\``,
			``,
			`Address each outstanding comment. If changes are needed, describe what`,
			`you plan to do (a separate implement task will handle the code changes).`,
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
			`Generate the requested summary or digest. You may use the bash tool to`,
			`query GitHub (e.g. \`gh pr list\`, \`gh issue list\`, \`gh run list\`) or`,
			`inspect files as needed.`,
			``,
			`Return your summary as a well-formatted Markdown document. Include`,
			`relevant statistics, highlights, and action items where appropriate.`,
			`When done, output the final Markdown — that is your result.`,
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
		`whatever verification (tests, build) you can. When you are done, summarize`,
		`what you changed and stop calling tools.`,
	].join('\n')
}

function extractText(content: Anthropic.ContentBlock[]): string | null {
	const parts: string[] = []
	for (const block of content) {
		if (block.type === 'text') parts.push(block.text)
	}
	if (parts.length === 0) return null
	return parts.join('\n').trim()
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		const err = new Error('aborted')
		err.name = 'AbortError'
		throw err
	}
}

/**
 * Build the per-task system prompt, optionally augmented with project-specific
 * instructions discovered in the target repo (AGENTS.md / CLAUDE.md / …).
 */
export function buildSystemPrompt(opts: {
	memberName: string
	repo: string | null
	projectInstructions: string | null
}): string {
	const sections: string[] = [
		`You are Night Agent ${opts.memberName}, an autonomous coding agent that finishes implementation tasks end-to-end.`,
		``,
		`# Operating principles`,
		`- Stay inside the workspace. Do not access or modify files outside it.`,
		`- Make small, logical commits as you go — do not batch every change into one commit at the end.`,
		`- Run available verification (tests, build) before declaring the task done.`,
		`- If you cannot finish (missing context, blocked by something out of scope), say so clearly and stop calling tools.`,
		`- Never print, log, or include secrets/credentials in tool inputs or outputs.`,
	]
	if (opts.repo) {
		sections.push(``, `# Repository`, `Working on \`${opts.repo}\`.`)
	}
	if (opts.projectInstructions && opts.projectInstructions.trim().length > 0) {
		sections.push(
			``,
			`# Project-specific instructions`,
			`The repository ships its own agent guide. Treat it as authoritative when it conflicts with the operating principles above.`,
			``,
			opts.projectInstructions.trim(),
		)
	}
	return sections.join('\n')
}
