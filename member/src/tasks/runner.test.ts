import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StubProvider } from '../agent/stub.ts'
import type { MemberLimits, TokenUsage } from '../agent/types.ts'
import {
	formatTokenBudgetHint,
	bashTimeoutMsForKind,
	maxIterationsForKind,
	parseReviewOutput,
	parseTriageOutput,
	prTitleFor,
	summarizeForCommit,
	TaskRunner,
	type AssignedTaskInput,
} from './runner.ts'
import { Workspace } from './workspace.ts'

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

describe('bashTimeoutMsForKind', () => {
	it('tightens read-mostly kinds to 60s so a runaway search fails fast', () => {
		expect(bashTimeoutMsForKind('triage')).toBe(60_000)
		expect(bashTimeoutMsForKind('review')).toBe(60_000)
		expect(bashTimeoutMsForKind('respond')).toBe(60_000)
		expect(bashTimeoutMsForKind('summarize')).toBe(60_000)
	})

	it('keeps the 5-minute budget for kinds that build / test', () => {
		expect(bashTimeoutMsForKind('implement')).toBe(5 * 60_000)
		expect(bashTimeoutMsForKind('rebase')).toBe(5 * 60_000)
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
			preview: { basePort: 4321, readyTimeoutMs: 120_000, publishMode: 'local' },
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
			override async runAgent(opts: Parameters<StubProvider['runAgent']>[0]) {
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
			preview: { basePort: 4321, readyTimeoutMs: 120_000, publishMode: 'local' },
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
			override async runAgent(opts: Parameters<StubProvider['runAgent']>[0]) {
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
			preview: { basePort: 4321, readyTimeoutMs: 120_000, publishMode: 'local' },
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

describe('TaskRunner — end-to-end (implement, with stubbed Workspace)', () => {
	let workspaceDir: string
	let workPath: string

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), 'runner-impl-'))
		workPath = join(workspaceDir, 'work')
		// The stub Workspace claims this path; tools (write_file, bash) need
		// it to actually exist on disk so the StubProvider can write a marker.
		const { mkdir } = await import('node:fs/promises')
		await mkdir(workPath, { recursive: true })
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await rm(workspaceDir, { recursive: true, force: true })
	})

	function buildStubWorkspace(overrides: Partial<Record<string, unknown>> = {}): {
		workspace: Workspace
		commit: ReturnType<typeof vi.fn>
		push: ReturnType<typeof vi.fn>
		upsertDraftPr: ReturnType<typeof vi.fn>
		markPrReady: ReturnType<typeof vi.fn>
		readProjectInstructions: ReturnType<typeof vi.fn>
		cleanup: ReturnType<typeof vi.fn>
	} {
		const stub = {
			taskId: 't-impl',
			repo: 'o/r',
			path: workPath,
			cachePath: join(workspaceDir, '.cache', 'o', 'r.git'),
			branch: 'pr/night/abc-fix',
			baseBranch: 'main',
			readProjectInstructions: vi.fn().mockResolvedValue(null),
			commit: vi.fn().mockResolvedValue({ sha: 'cafebabe' }),
			push: vi.fn().mockResolvedValue(undefined),
			upsertDraftPr: vi.fn().mockResolvedValue({ url: 'https://github.com/o/r/pull/9' }),
			markPrReady: vi.fn().mockResolvedValue(undefined),
			cleanup: vi.fn().mockResolvedValue(undefined),
			...overrides,
		}
		// Read the spies off `stub` (not the originals) so overrides flow
		// through. `vi.fn().mockRejectedValue(...)` passed via `overrides`
		// fully replaces the default mock.
		return {
			workspace: stub as unknown as Workspace,
			commit: stub.commit as ReturnType<typeof vi.fn>,
			push: stub.push as ReturnType<typeof vi.fn>,
			upsertDraftPr: stub.upsertDraftPr as ReturnType<typeof vi.fn>,
			markPrReady: stub.markPrReady as ReturnType<typeof vi.fn>,
			readProjectInstructions: stub.readProjectInstructions as ReturnType<typeof vi.fn>,
			cleanup: stub.cleanup as ReturnType<typeof vi.fn>,
		}
	}

	function buildRunner(): { runner: TaskRunner; sent: unknown[] } {
		const sent: unknown[] = []
		const runner = new TaskRunner({
			memberName: 'octo',
			memberId: 'm-test',
			householdUrl: 'https://night.example',
			provider: new StubProvider('stub-model'),
			limits: NO_LIMITS,
			dailyUsage: { tokensToday: () => 0, record: () => undefined },
			workspaceDir,
			logger: silentLogger,
			wsSend: (msg) => {
				sent.push(msg)
				return true
			},
			stubMode: true,
			preview: { basePort: 4321, readyTimeoutMs: 120_000, publishMode: 'local' },
		})
		return { runner, sent }
	}

	function implementTask(taskId = 't-impl'): AssignedTaskInput {
		return {
			taskId,
			kind: 'implement',
			title: 'Add login screen',
			description: 'A description of the task.',
			repo: 'o/r',
			prUrl: null,
			githubToken: 'fake-token',
			repoUrl: 'https://github.com/o/r.git',
			// Null metadata skips the eyes-reaction probe (which would call real `gh`).
			metadata: null,
		}
	}

	it('golden path: workspace → commit → push → draft PR → ready, returns prUrl', async () => {
		const { workspace, commit, push, upsertDraftPr, markPrReady } = buildStubWorkspace()
		vi.spyOn(Workspace, 'create').mockResolvedValue(workspace)

		const { runner, sent } = buildRunner()
		const outcome = await runner.run(implementTask())

		expect(outcome.type).toBe('completed')
		expect(outcome.prUrl).toBe('https://github.com/o/r/pull/9')

		// Commit message threads through summarizeForCommit (subject from agent
		// summary, then full summary as body) and the agent name as committer.
		expect(commit).toHaveBeenCalledTimes(1)
		const [commitMsg, agentName] = commit.mock.calls[0]!
		expect(agentName).toBe('octo')
		expect(commitMsg).toMatch(/Stub agent completed task "Add login screen"/)

		// Push runs exactly once after a successful commit.
		expect(push).toHaveBeenCalledTimes(1)

		// Draft PR is opened with the task title (sliced if needed) and a body
		// that carries the agent summary; then transitioned to ready.
		expect(upsertDraftPr).toHaveBeenCalledTimes(1)
		const prArgs = upsertDraftPr.mock.calls[0]![0] as { title: string; body: string }
		expect(prArgs.title).toBe('Add login screen')
		expect(prArgs.body).toContain('## Summary')
		expect(prArgs.body).toContain('Stub agent completed task')

		expect(markPrReady).toHaveBeenCalledWith('https://github.com/o/r/pull/9')

		// Wire-level events include the draft-PR-opened and ready milestones.
		const messages = sent as Array<{ kind?: string; payload?: { message?: string } }>
		const logMessages = messages.filter((m) => m.kind === 'log').map((m) => m.payload?.message)
		expect(logMessages).toContain('workspace ready')
		expect(logMessages).toContain('pushed')
		expect(logMessages).toContain('draft PR opened')
		expect(logMessages).toContain('PR ready for review')
	})

	it('triage clones a workspace to read the code but never commits/pushes/opens a PR', async () => {
		const { workspace, commit, push, upsertDraftPr, cleanup } = buildStubWorkspace()
		const create = vi.spyOn(Workspace, 'create').mockResolvedValue(workspace)

		const { runner, sent } = buildRunner()
		const outcome = await runner.run({
			...implementTask('t-triage'),
			kind: 'triage',
		})

		// Repo is cloned (the agent needs the tree to judge clarity/size)…
		expect(create).toHaveBeenCalledTimes(1)
		const messages = sent as Array<{ kind?: string; payload?: { message?: string } }>
		const logMessages = messages.filter((m) => m.kind === 'log').map((m) => m.payload?.message)
		expect(logMessages).toContain('workspace ready')

		// …but triage's only output is the issue comment it posted via the tool;
		// it must not turn the worktree into a commit/PR.
		expect(commit).not.toHaveBeenCalled()
		expect(push).not.toHaveBeenCalled()
		expect(upsertDraftPr).not.toHaveBeenCalled()

		expect(outcome.type).toBe('completed')
		expect(outcome.prUrl).toBeUndefined()
		// Worktree is still reclaimed on the no-PR path.
		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it('marks the task failed with reason "push_failed" when push throws', async () => {
		const { workspace, push, upsertDraftPr } = buildStubWorkspace({
			push: vi.fn().mockRejectedValue(new Error('boom')),
		})
		vi.spyOn(Workspace, 'create').mockResolvedValue(workspace)

		const { runner } = buildRunner()
		const outcome = await runner.run(implementTask('t-push-fail'))

		expect(outcome.type).toBe('failed')
		expect(outcome.reason).toBe('push_failed')
		expect(push).toHaveBeenCalledTimes(1)
		// PR steps must NOT run after a push failure — that would publish a
		// branch ref the remote doesn't have.
		expect(upsertDraftPr).not.toHaveBeenCalled()
	})

	it('marks the implement task failed with "no_changes" when commit returns null', async () => {
		const { workspace, push, upsertDraftPr } = buildStubWorkspace({
			commit: vi.fn().mockResolvedValue(null),
		})
		vi.spyOn(Workspace, 'create').mockResolvedValue(workspace)

		const { runner } = buildRunner()
		const outcome = await runner.run(implementTask('t-no-changes'))

		expect(outcome.type).toBe('failed')
		expect(outcome.reason).toBe('no_changes')
		// Without a commit there's nothing to push or PR.
		expect(push).not.toHaveBeenCalled()
		expect(upsertDraftPr).not.toHaveBeenCalled()
	})

	it('drops the worktree via workspace.cleanup() on the success path', async () => {
		const { workspace, cleanup } = buildStubWorkspace()
		vi.spyOn(Workspace, 'create').mockResolvedValue(workspace)

		const { runner } = buildRunner()
		await runner.run(implementTask('t-cleanup-success'))

		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it('still calls workspace.cleanup() when the task fails (e.g. push throws)', async () => {
		// Disk reclaim must not depend on the success path. A worktree
		// leaked here once piled up to 100s of GB on the slow-failing
		// branches before we noticed.
		const { workspace, cleanup } = buildStubWorkspace({
			push: vi.fn().mockRejectedValue(new Error('boom')),
		})
		vi.spyOn(Workspace, 'create').mockResolvedValue(workspace)

		const { runner } = buildRunner()
		const outcome = await runner.run(implementTask('t-cleanup-fail'))

		expect(outcome.type).toBe('failed')
		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it('does not surface a cleanup error to the caller (best-effort, logged only)', async () => {
		const { workspace } = buildStubWorkspace({
			cleanup: vi.fn().mockRejectedValue(new Error('worktree remove flaked')),
		})
		vi.spyOn(Workspace, 'create').mockResolvedValue(workspace)

		const { runner } = buildRunner()
		// Returns the underlying outcome unmodified — the cleanup throw
		// must NOT bubble out of run() and corrupt the wire-level result.
		const outcome = await runner.run(implementTask('t-cleanup-throws'))
		expect(outcome.type).toBe('completed')
		expect(outcome.prUrl).toBe('https://github.com/o/r/pull/9')
	})

	it('skips PR steps but still commits + pushes when no GitHub token is provided', async () => {
		const { workspace, commit, push, upsertDraftPr, markPrReady } = buildStubWorkspace()
		vi.spyOn(Workspace, 'create').mockResolvedValue(workspace)

		const { runner, sent } = buildRunner()
		const outcome = await runner.run({ ...implementTask('t-no-token'), githubToken: '' })

		expect(outcome.type).toBe('completed')
		expect(outcome.prUrl).toBeUndefined()
		expect(commit).toHaveBeenCalledTimes(1)
		expect(push).toHaveBeenCalledTimes(1)
		expect(upsertDraftPr).not.toHaveBeenCalled()
		expect(markPrReady).not.toHaveBeenCalled()
		const logMessages = (sent as Array<{ kind?: string; payload?: { message?: string } }>)
			.filter((m) => m.kind === 'log')
			.map((m) => m.payload?.message)
		expect(logMessages).toContain('PR skipped (no GitHub token)')
	})
})

describe('TaskRunner — end-to-end (rebase, with stubbed Workspace)', () => {
	let workspaceDir: string

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), 'runner-rebase-'))
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await rm(workspaceDir, { recursive: true, force: true })
	})

	function buildRunner(): { runner: TaskRunner; sent: unknown[] } {
		const sent: unknown[] = []
		const runner = new TaskRunner({
			memberName: 'octo',
			memberId: 'm-test',
			householdUrl: 'https://night.example',
			provider: new StubProvider('stub-model'),
			limits: NO_LIMITS,
			dailyUsage: { tokensToday: () => 0, record: () => undefined },
			workspaceDir,
			logger: silentLogger,
			wsSend: (msg) => {
				sent.push(msg)
				return true
			},
			stubMode: true,
			preview: { basePort: 4321, readyTimeoutMs: 120_000, publishMode: 'local' },
		})
		return { runner, sent }
	}

	function rebaseTask(): AssignedTaskInput {
		return {
			taskId: 't-rebase',
			kind: 'rebase',
			title: 'Rebase: Speed up widget',
			description: 'PR is behind main.',
			repo: 'o/r',
			prUrl: 'https://github.com/o/r/pull/9',
			githubToken: 'fake-token',
			repoUrl: 'https://github.com/o/r.git',
			metadata: { head_ref: 'pr/night/abc-speed', base_ref: 'main' },
		}
	}

	function stubRebaseWorkspace(behind: number) {
		const countBehindBase = vi.fn().mockResolvedValue(behind)
		const rebaseOntoBase = vi
			.fn()
			.mockResolvedValue({ rewroteCommits: true, newSha: 'deadbeef' })
		const pushWithLease = vi.fn().mockResolvedValue(undefined)
		const cleanup = vi.fn().mockResolvedValue(undefined)
		const stub = { countBehindBase, rebaseOntoBase, pushWithLease, cleanup }
		vi.spyOn(Workspace, 'createForRebase').mockResolvedValue(stub as unknown as Workspace)
		return { countBehindBase, rebaseOntoBase, pushWithLease, cleanup }
	}

	it('no-ops without rebasing or force-pushing when the head is already current', async () => {
		const { rebaseOntoBase, pushWithLease } = stubRebaseWorkspace(0)
		const { runner, sent } = buildRunner()

		const outcome = await runner.run(rebaseTask())

		expect(outcome.type).toBe('completed')
		expect((outcome as { result: { upToDate?: boolean } }).result.upToDate).toBe(true)
		expect(rebaseOntoBase).not.toHaveBeenCalled()
		expect(pushWithLease).not.toHaveBeenCalled()

		const rebaseEvents = (sent as Array<{ kind?: string; payload?: { outcome?: string } }>)
			.filter((m) => m.kind === 'rebase')
			.map((m) => m.payload?.outcome)
		expect(rebaseEvents).toContain('up-to-date')
	})

	it('rebases and force-pushes with lease when the head is behind base', async () => {
		const { rebaseOntoBase, pushWithLease } = stubRebaseWorkspace(3)
		const { runner } = buildRunner()

		const outcome = await runner.run(rebaseTask())

		expect(outcome.type).toBe('completed')
		expect((outcome as { result: { rebased?: boolean } }).result.rebased).toBe(true)
		expect(rebaseOntoBase).toHaveBeenCalledTimes(1)
		expect(pushWithLease).toHaveBeenCalledTimes(1)
	})
})
