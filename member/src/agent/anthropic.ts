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

		// Mark the last tool definition as a cache breakpoint. Anthropic caches
		// all content above (and including) a `cache_control: ephemeral` block,
		// so this tags the entire tool array as cacheable. Tools don't change
		// across iterations, so every turn after the first reads them from
		// cache instead of re-sending them as fresh input tokens.
		const sdkTools: Anthropic.ToolUnion[] = tools.map((t, i) => ({
			name: t.name,
			description: t.description,
			input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
			...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
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

		// Estimate is a cheap sizing pass — skip extended thinking to keep token
		// spend proportional to the task. Implement/review/respond/summarize
		// benefit from adaptive reasoning.
		const useThinking = task.kind !== 'estimate'

		for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration++) {
			throwIfAborted(abortSignal)

			// Mark the latest user turn (kickoff or most-recent tool_results) as a
			// cache breakpoint, stripping the previous one so we never exceed the
			// 4-breakpoint API limit. Combined with `cache_control` on the system
			// prompt and last tool, every iteration after the first reads the
			// entire prior conversation from cache instead of paying full input
			// rate on the growing message history.
			markLatestUserAsCacheBreakpoint(messages)

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
				...(useThinking ? { thinking: { type: 'adaptive' } } : {}),
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

	if (kind === 'estimate') {
		return [
			`# Estimate: ${title}`,
			``,
			`## Task description`,
			description.trim(),
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
		`## How to do this task`,
		`This is a code-editing task. You MUST modify files using the provided tools — answering with prose alone counts as failure (your changes are detected by \`git status\`; if no files changed, the task fails as \`no_changes\`).`,
		``,
		`Required workflow — call tools, do not just describe:`,
		`1. Use \`bash\` (e.g. \`ls -la\`, \`cat README.md\`, \`rg <pattern>\`) and \`read_file\` to understand the relevant files.`,
		`2. Use \`write_file\` to apply every change. One \`write_file\` per file you want to change; provide the full new contents.`,
		`3. Use \`bash\` to run any tests, builds, or linters available in the repo. Fix what you broke before stopping.`,
		`4. Only after the files actually look right on disk, stop calling tools and summarize what you changed.`,
		``,
		`If the task is genuinely impossible (missing context, request out of scope), still call no further tools and explicitly say so in your final summary — but only after at least exploring the repo.`,
	].join('\n')
}

/**
 * Strip any pre-existing `cache_control` from user-message content blocks and
 * place a fresh `ephemeral` breakpoint on the last block of the latest user
 * message. Anthropic caches longest-prefix-matching content automatically;
 * the breakpoint tells the API where to stop and write a new cache layer.
 *
 * Why we move (not accumulate) the breakpoint: the API caps at 4 cache
 * breakpoints per request, and we already use two for `system` and `tools`.
 * Keeping just one moving breakpoint on the user side stays comfortably
 * under the limit no matter how long the conversation grows.
 */
function markLatestUserAsCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
	for (const m of messages) {
		if (m.role !== 'user' || !Array.isArray(m.content)) continue
		for (const block of m.content) {
			if (typeof block === 'object' && block !== null && 'cache_control' in block) {
				delete (block as { cache_control?: unknown }).cache_control
			}
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!
		if (m.role !== 'user' || !Array.isArray(m.content) || m.content.length === 0) continue
		const last = m.content[m.content.length - 1] as { cache_control?: unknown }
		last.cache_control = { type: 'ephemeral' }
		return
	}
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
		`You are ${opts.memberName}, a Night Family member — an autonomous coding agent that finishes implementation tasks end-to-end.`,
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
