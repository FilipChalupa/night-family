import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StubProvider } from '../agent/stub.ts'
import type { MemberLimits, TokenUsage } from '../agent/types.ts'
import {
	formatTokenBudgetHint,
	maxIterationsForKind,
	parseReviewOutput,
	parseTriageOutput,
	prTitleFor,
	summarizeForCommit,
	TaskRunner,
	type AssignedTaskInput,
} from './runner.ts'

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	trace: () => {},
	fatal: () => {},
	level: 'silent',
	child: () => silentLogger,
} as unknown as Logger

const NO_LIMITS: MemberLimits = {
	maxTokensPerTask: null,
	maxTokensPerDay: null,
	maxTaskDurationMinutes: 60,
}

describe('parseTriageOutput', () => {
	it('parses a question outcome', () => {
		const out = parseTriageOutput('Some prose.\n\n{"outcome":"question"}')
		expect(out).toEqual({ outcome: 'question' })
	})

	it('parses a plan outcome with size', () => {
		expect(parseTriageOutput('… {"outcome":"plan","size":"M"}')).toEqual({
			outcome: 'plan',
			size: 'M',
		})
		expect(parseTriageOutput('… {"outcome":"plan","size":"XL"}')).toEqual({
			outcome: 'plan',
			size: 'XL',
		})
	})

	it('omits size when the plan size is unrecognised', () => {
		expect(parseTriageOutput('{"outcome":"plan","size":"weird"}')).toEqual({ outcome: 'plan' })
	})

	it('falls back to unknown when no JSON line is present', () => {
		expect(parseTriageOutput('agent rambled and forgot the JSON')).toEqual({
			outcome: 'unknown',
		})
	})

	it('falls back to unknown on malformed JSON', () => {
		expect(parseTriageOutput('{"outcome":"plan",}')).toEqual({ outcome: 'unknown' })
	})

	it('falls back to unknown on an unrecognised outcome value', () => {
		expect(parseTriageOutput('{"outcome":"maybe"}')).toEqual({ outcome: 'unknown' })
	})
})

describe('parseReviewOutput', () => {
	it.each([
		['approved' as const, '{"verdict":"approved"}'],
		['changes_requested' as const, 'preamble {"verdict":"changes_requested"} tail'],
		['commented' as const, '{"verdict":"commented"}'],
	])('parses verdict %s', (verdict, body) => {
		const out = parseReviewOutput(body)
		expect(out.verdict).toBe(verdict)
		expect(out.summary).toBe(body)
	})

	it('falls back to commented when JSON is absent', () => {
		expect(parseReviewOutput('looks good')).toEqual({
			verdict: 'commented',
			summary: 'looks good',
		})
	})

	it('falls back to commented on an unrecognised verdict', () => {
		expect(parseReviewOutput('{"verdict":"approve"}').verdict).toBe('commented')
	})
})

describe('formatTokenBudgetHint', () => {
	it('returns null with no caps configured', () => {
		expect(formatTokenBudgetHint(NO_LIMITS, 0)).toBeNull()
	})

	it('renders only the per-task line when only that cap is set', () => {
		const out = formatTokenBudgetHint({ ...NO_LIMITS, maxTokensPerTask: 50_000 }, 0)
		expect(out).toBe('Token budget: ~50,000 for this task.')
	})

	it("renders the daily remaining line, subtracting today's spend", () => {
		const out = formatTokenBudgetHint({ ...NO_LIMITS, maxTokensPerDay: 200_000 }, 75_000)
		expect(out).toBe('Token budget: ~125,000 remaining today.')
	})

	it('clamps the daily remaining at 0 when overspent', () => {
		const out = formatTokenBudgetHint({ ...NO_LIMITS, maxTokensPerDay: 100_000 }, 250_000)
		expect(out).toBe('Token budget: ~0 remaining today.')
	})

	it('joins both segments when both caps are set', () => {
		const out = formatTokenBudgetHint(
			{ ...NO_LIMITS, maxTokensPerTask: 50_000, maxTokensPerDay: 200_000 },
			10_000,
		)
		expect(out).toBe('Token budget: ~50,000 for this task; ~190,000 remaining today.')
	})
})

describe('maxIterationsForKind', () => {
	it('caps short tasks at 12', () => {
		expect(maxIterationsForKind('review')).toBe(12)
		expect(maxIterationsForKind('triage')).toBe(12)
		expect(maxIterationsForKind('respond')).toBe(12)
	})

	it('keeps long tasks at the 30-iteration default', () => {
		expect(maxIterationsForKind('implement')).toBe(30)
		expect(maxIterationsForKind('summarize')).toBe(30)
		expect(maxIterationsForKind('rebase')).toBe(30)
	})
})

describe('summarizeForCommit', () => {
	it('uses the first line as commit subject when it fits', () => {
		const out = summarizeForCommit('Fallback', 'Fix bug X\n\nMore details here.')
		expect(out.startsWith('Fix bug X\n\n')).toBe(true)
	})

	it('falls back to the task title when the first line is empty', () => {
		const out = summarizeForCommit('Task title', '\n\nbody only')
		expect(out.startsWith('Task title\n\n')).toBe(true)
	})

	it('falls back to the task title when the first line is too long (≥ 72 chars)', () => {
		const longLine = 'x'.repeat(80)
		const out = summarizeForCommit('Task title', `${longLine}\n\nbody`)
		expect(out.startsWith('Task title\n\n')).toBe(true)
	})

	it('keeps the full summary in the body regardless of subject choice', () => {
		const summary = 'first\n\nsecond'
		expect(summarizeForCommit('t', summary).endsWith(summary)).toBe(true)
	})
})

describe('prTitleFor', () => {
	it('passes short titles through unchanged', () => {
		expect(prTitleFor('Add login screen')).toBe('Add login screen')
	})

	it('truncates at 200 characters', () => {
		const t = 'x'.repeat(250)
		expect(prTitleFor(t)).toHaveLength(200)
	})
})

describe('TaskRunner — end-to-end (summarize, no workspace)', () => {
	let workspaceDir: string

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), 'runner-test-'))
	})

	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true })
	})

	function buildRunner() {
		const sent: unknown[] = []
		const usageRecords: TokenUsage[] = []
		const runner = new TaskRunner({
			memberName: 'octo',
			memberId: 'm-test',
			householdUrl: 'https://night.example',
			provider: new StubProvider('stub-model'),
			limits: NO_LIMITS,
			dailyUsage: {
				tokensToday: () => 0,
				record: (u) => usageRecords.push(u),
			},
			workspaceDir,
			logger: silentLogger,
			wsSend: (msg) => {
				sent.push(msg)
				return true
			},
			stubMode: true,
		})
		return { runner, sent, usageRecords }
	}

	function summarizeTask(taskId = 't-summary'): AssignedTaskInput {
		return {
			taskId,
			kind: 'summarize',
			title: 'Weekly digest',
			description: 'Summarize last week of PR activity.',
			repo: null,
			prUrl: null,
			githubToken: '',
			repoUrl: '',
			metadata: null,
		}
	}

	it('runs to completion, returns a summary result, and never touches a workspace clone', async () => {
		const { runner, sent } = buildRunner()
		const outcome = await runner.run(summarizeTask())

		expect(outcome.type).toBe('completed')
		expect(outcome.result).toMatchObject({
			summary: expect.stringContaining('Stub agent completed task "Weekly digest"'),
		})
		// No `pr/night/...` branch ever created → no .cache or worktree dir.
		await expect(stat(join(workspaceDir, '.cache'))).rejects.toThrow()
	})

	it('emits task-lifecycle events to wsSend in order', async () => {
		const { runner, sent } = buildRunner()
		await runner.run(summarizeTask())

		const messages = sent as Array<{ type?: string; kind?: string; payload?: unknown }>
		// All emissions for a task come through as `event` envelopes.
		expect(messages.every((m) => m.type === 'event')).toBe(true)
		const kinds = messages.map((m) => m.kind)
		expect(kinds[0]).toBe('log') // "task started"
		expect(kinds).toContain('usage')
		// At least one tool_call from the stub agent's write_file/bash.
		expect(kinds).toContain('tool_call')
		// Final log marks "task complete".
		const lastLogIdx = (() => {
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i]?.kind === 'log') return i
			}
			return -1
		})()
		expect(lastLogIdx).toBeGreaterThan(-1)
		const lastLog = messages[lastLogIdx]?.payload as { message?: string }
		expect(lastLog?.message).toBe('task complete')
	})

	it('persists events to the per-task NDJSON buffer on disk', async () => {
		const { runner } = buildRunner()
		await runner.run(summarizeTask('t-persist'))

		const ndjson = await readFile(join(workspaceDir, 't-persist', 'events.ndjson'), 'utf8')
		const lines = ndjson.trim().split('\n')
		expect(lines.length).toBeGreaterThan(0)
		// Every line is valid JSON with a monotonic seq.
		const events = lines.map((l) => JSON.parse(l) as { seq: number; kind: string })
		expect(events[0]?.seq).toBe(1)
		for (let i = 1; i < events.length; i++) {
			expect(events[i]!.seq).toBe(events[i - 1]!.seq + 1)
		}
	})

	it('shapes a review-task result via parseReviewOutput (verdict in JSON wins)', async () => {
		// Custom provider that returns a JSON-tail summary the way a real
		// review agent would. Routes through TaskRunner.shapeResult →
		// parseReviewOutput, which is the only place verdict normalization
		// happens before Household sees the wire-level result.
		class VerdictProvider extends StubProvider {
			async runAgent(opts: Parameters<StubProvider['runAgent']>[0]) {
				const usage = { input: 100, output: 50 }
				await opts.onEvent({ kind: 'usage', payload: usage })
				return {
					summary: 'Looks good with one nit.\n\n{"verdict":"approved"}',
					usage,
				}
			}
		}

		const sent: unknown[] = []
		const runner = new TaskRunner({
			memberName: 'octo',
			memberId: 'm-test',
			householdUrl: 'https://night.example',
			provider: new VerdictProvider('stub-model'),
			limits: NO_LIMITS,
			dailyUsage: { tokensToday: () => 0, record: () => undefined },
			workspaceDir,
			logger: silentLogger,
			wsSend: (msg) => {
				sent.push(msg)
				return true
			},
			stubMode: true,
		})

		const outcome = await runner.run({
			taskId: 't-review',
			kind: 'review',
			title: 'Review PR #42',
			description: 'Please review the new login flow.',
			repo: 'o/r',
			prUrl: 'https://github.com/o/r/pull/42',
			githubToken: '',
			repoUrl: '',
			metadata: null,
		})

		expect(outcome.type).toBe('completed')
		expect(outcome.result).toMatchObject({
			verdict: 'approved',
			summary: expect.stringContaining('{"verdict":"approved"}'),
		})
	})

	it('falls back to verdict "commented" when the agent forgets the JSON tail', async () => {
		// Same review-task path but the agent doesn't end with parsable JSON.
		// shapeResult must still produce a usable verdict for Household.
		class NoJsonProvider extends StubProvider {
			async runAgent(opts: Parameters<StubProvider['runAgent']>[0]) {
				const usage = { input: 0, output: 0 }
				await opts.onEvent({ kind: 'usage', payload: usage })
				return { summary: 'looked at it, all fine', usage }
			}
		}

		const runner = new TaskRunner({
			memberName: 'octo',
			memberId: 'm-test',
			householdUrl: 'https://night.example',
			provider: new NoJsonProvider('stub-model'),
			limits: NO_LIMITS,
			dailyUsage: { tokensToday: () => 0, record: () => undefined },
			workspaceDir,
			logger: silentLogger,
			wsSend: () => true,
			stubMode: true,
		})

		const outcome = await runner.run({
			taskId: 't-review-bare',
			kind: 'review',
			title: 'Review PR',
			description: 'd',
			repo: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
			githubToken: '',
			repoUrl: '',
			metadata: null,
		})

		expect(outcome.type).toBe('completed')
		expect(outcome.result).toMatchObject({ verdict: 'commented' })
	})

	it('records token usage on the daily tracker', async () => {
		const { runner, usageRecords } = buildRunner()
		await runner.run(summarizeTask('t-usage'))

		// StubProvider reports zero usage but still calls record() once.
		expect(usageRecords).toHaveLength(1)
		expect(usageRecords[0]).toEqual({ input: 0, output: 0 })
	})
})
