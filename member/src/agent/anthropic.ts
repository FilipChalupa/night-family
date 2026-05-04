/**
 * Anthropic provider — Claude tool-use loop using the official SDK.
 *
 * Manual loop (over .stream() + .finalMessage()) so we have full control over
 * cancellation, streaming, redaction of intermediate results, and per-turn
 * event emission to Household.
 */

import Anthropic from '@anthropic-ai/sdk'
import { buildAttributionInstruction } from '../attribution.ts'
import type { AgentTask, Provider, RunAgentOptions, RunAgentResult, TokenUsage } from './types.ts'

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
						text: buildKickoffPrompt(task),
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

function buildKickoffPrompt(task: AgentTask): string {
	const { title, description, kind, prUrl, repo, metadata, attributionFooter } = task
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
			`3. Analyse the diff for correctness, style, security, and test coverage.`,
			`4. Post your review with one of:`,
			`   - \`gh pr review ${prUrl} --approve -b "<comment>"\``,
			`   - \`gh pr review ${prUrl} --request-changes -b "<comment>"\``,
			`   - \`gh pr review ${prUrl} --comment -b "<comment>"\``,
			``,
			`If \`--approve\` (or \`--request-changes\`) fails because GitHub forbids`,
			`acting on your own pull request, fall back to \`gh pr review --comment\``,
			`with the same body and still report your verdict accurately in the JSON`,
			`block — the household tracks approvals internally regardless of what the`,
			`GitHub UI shows.`,
			``,
			buildAttributionInstruction(attributionFooter),
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
			buildAttributionInstruction(attributionFooter),
			``,
			`Address each outstanding comment. If changes are needed, describe what`,
			`you plan to do (a separate implement task will handle the code changes).`,
			`When done, summarize the responses you posted.`,
		].join('\n')
	}

	if (kind === 'estimate') {
		const ackLines =
			repo && issueNumber !== null
				? [
						``,
						`## Acknowledge the issue first`,
						`Before doing anything else, post an 👀 reaction on the source issue so`,
						`anyone watching it on GitHub knows the bot picked it up:`,
						``,
						`\`gh api -X POST /repos/${repo}/issues/${issueNumber}/reactions -f content=eyes\``,
						``,
						`If the request fails (e.g. permission denied) log it and continue —`,
						`the reaction is best-effort, never block the estimate on it.`,
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
		`You are ${opts.memberName}, a Night Family member — an automated coding agent.`,
		``,
		`# Environment`,
		`You operate inside a checked-out git working tree of a single repository, on a fresh branch created just for this task. The current directory is that tree; relative paths in your tools refer to it. **You will not commit, push, or open a PR yourself** — the runner around you does all of that automatically once you stop calling tools. Your job is to edit the files.`,
		``,
		`# Tools`,
		`- \`read_file(path)\` — read a file in the workspace.`,
		`- \`write_file(path, content)\` — overwrite a file with the full new contents (no diffs, no patches).`,
		`- \`bash(command)\` — run a shell command in the workspace (60-second timeout). Use it for \`ls\`, \`rg\`, tests, builds, formatters, package managers.`,
		``,
		`# Ground rules`,
		`- Stay inside the workspace. Do not touch files outside it.`,
		`- Never print, log, or pass through secrets or credentials.`,
		`- When you are finished editing, write a short final summary of what you changed and stop calling tools.`,
	]
	if (opts.repo) {
		sections.push(``, `# Repository`, `\`${opts.repo}\``)
	}
	if (opts.projectInstructions && opts.projectInstructions.trim().length > 0) {
		sections.push(
			``,
			`# Project-specific instructions`,
			`The repository ships its own agent guide; treat it as authoritative when it conflicts with anything above.`,
			``,
			opts.projectInstructions.trim(),
		)
	}
	return sections.join('\n')
}
