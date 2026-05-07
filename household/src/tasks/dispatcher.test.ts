import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema.ts'
import { MemberRegistry, type ConnectedMember } from '../members/registry.ts'
import { MemberStateStore } from '../members/store.ts'
import { Dispatcher } from './dispatcher.ts'
import { TaskJobStore } from './jobStore.ts'
import { TaskStore } from './store.ts'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

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

interface Rig {
	taskStore: TaskStore
	jobStore: TaskJobStore
	registry: MemberRegistry
	memberStore: MemberStateStore
	dispatcher: Dispatcher
	cleanup: () => void
}

function createRig(): Rig {
	const dir = mkdtempSync(join(tmpdir(), 'night-disp-test-'))
	const sqlite = new Database(join(dir, 'test.sqlite'))
	sqlite.pragma('journal_mode = WAL')
	sqlite.pragma('foreign_keys = ON')
	const db = drizzle(sqlite, { schema })
	migrate(db, { migrationsFolder })

	const taskStore = new TaskStore(db)
	const jobStore = new TaskJobStore(db)
	const memberStore = new MemberStateStore(db)
	const registry = new MemberRegistry(memberStore)
	const dispatcher = new Dispatcher({
		taskStore,
		jobStore,
		registry,
		logger: silentLogger,
	})
	return {
		taskStore,
		jobStore,
		registry,
		memberStore,
		dispatcher,
		cleanup: () => {
			sqlite.close()
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

function fakeMember(opts: {
	memberName: string
	repos?: string[] | null
	status?: 'idle' | 'busy'
	send?: (m: unknown) => void
	skills?: ConnectedMember['skills']
	maxTokensPerDay?: number | null
}): ConnectedMember {
	const sessionId = `sess-${opts.memberName}-${Math.random().toString(16).slice(2, 8)}`
	return {
		sessionId,
		memberId: `mid-${sessionId}`,
		memberName: opts.memberName,
		displayName: opts.memberName,
		skills: opts.skills ?? ['implement', 'review'],
		// Always-on schedule keeps `implement` in the effective skill set so
		// dispatcher tests don't have to worry about wall-clock time.
		schedule: {
			timezone: 'UTC',
			nightWindows: [
				{
					name: 'always',
					days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
					start: '00:00',
					end: '24:00',
				},
			],
		},
		override: null,
		repos: opts.repos ?? null,
		provider: 'anthropic',
		model: 'm',
		workerProfile: 'medium',
		protocolVersion: '3.0.0',
		tokenId: 'tok',
		maxTokensPerDay: opts.maxTokensPerDay ?? null,
		connectedAt: new Date(),
		firstConnectedAt: new Date(),
		status: opts.status ?? 'idle',
		currentTask: null,
		lastHeartbeat: new Date(),
		send: opts.send ?? (() => {}),
		close: () => {},
	}
}

function createReadyImplementTask(rig: Rig, opts: { repo: string; assignedMemberName: string }) {
	const task = rig.taskStore.create({
		kind: 'implement',
		title: 't',
		description: 'd',
		repo: opts.repo,
	})
	// Add the implementer to the registry so the FK target row in `members`
	// exists when claimNextFor writes assigned_member_id, and so the JOIN-based
	// `assignedMemberName` resolves for prAuthorLogin fallback in the dispatcher.
	const existing = rig.registry.list().find((m) => m.memberName === opts.assignedMemberName)
	if (!existing) {
		rig.registry.add(fakeMember({ memberName: opts.assignedMemberName, status: 'busy' }))
	}
	const member = rig.registry.list().find((m) => m.memberName === opts.assignedMemberName)!
	const claimed = rig.taskStore.claimNextFor(['implement'], {
		sessionId: member.sessionId,
		memberId: member.memberId,
	})
	if (!claimed) throw new Error('failed to set up claimed task')
	rig.taskStore.transition(claimed.id, ['assigned'], 'in-progress', {
		prUrl: `https://github.com/${opts.repo}/pull/1`,
	})
	return rig.taskStore.get(claimed.id)!
}

describe('Dispatcher review picker', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
		vi.useRealTimers()
	})

	it('prefers an idle reviewer with a different GitHub login', () => {
		const aSent = vi.fn()
		const bSent = vi.fn()
		// 'a' is the implementer (PR author); 'b' is a different-login reviewer.
		rig.registry.add(fakeMember({ memberName: 'a', status: 'idle', send: aSent }))
		rig.registry.add(fakeMember({ memberName: 'b', status: 'idle', send: bSent }))
		const task = createReadyImplementTask(rig, { repo: 'o/r', assignedMemberName: 'a' })

		rig.dispatcher.dispatchReviewJobsFor(task)

		// Review goes to b (different login), never to a (PR author).
		expect(bSent).toHaveBeenCalled()
		const aSends = aSent.mock.calls
			.map((c) => c[0] as { type?: string })
			.filter((m) => m.type === 'task.assigned')
		expect(aSends).toHaveLength(0)
	})

	it('allows immediate self-review when only same-login members are connected', () => {
		const aSent = vi.fn()
		// Only 'a' is connected — same login as PR author. Solo-member case.
		rig.registry.add(fakeMember({ memberName: 'a', status: 'idle', send: aSent }))
		const task = createReadyImplementTask(rig, { repo: 'o/r', assignedMemberName: 'a' })
		// Mark 'a' idle again (createReadyImplementTask flipped them busy mid-setup).
		const a = rig.registry.list().find((m) => m.memberName === 'a')!
		rig.registry.updateStatus(a.sessionId, 'idle', null)

		rig.dispatcher.dispatchReviewJobsFor(task)

		const sends = aSent.mock.calls
			.map((c) => c[0] as { type?: string })
			.filter((m) => m.type === 'task.assigned')
		expect(sends.length).toBeGreaterThan(0)
	})

	it('queues pending and lets same-login claim only after 10 min when a different-login reviewer exists but is busy', () => {
		vi.useFakeTimers({ now: new Date('2026-05-03T00:00:00Z') })
		const aSent = vi.fn()
		const bSent = vi.fn()
		// 'a' will be PR author (idle when review fires, but I want to test the
		// stricter case: a same-login is idle, a different-login is busy → wait).
		// So make 'a' idle (same login, idle) and 'b' different-login but busy.
		rig.registry.add(fakeMember({ memberName: 'a', status: 'idle', send: aSent }))
		rig.registry.add(fakeMember({ memberName: 'b', status: 'busy', send: bSent }))
		const task = createReadyImplementTask(rig, { repo: 'o/r', assignedMemberName: 'a' })
		// createReadyImplementTask just flipped 'a' to busy too via claim. Restore idle.
		const a = rig.registry.list().find((m) => m.memberName === 'a')!
		rig.registry.updateStatus(a.sessionId, 'idle', null)

		rig.dispatcher.dispatchReviewJobsFor(task)

		// Nobody received a review job — different-login is busy, same-login waits.
		const sentAssign = (fn: ReturnType<typeof vi.fn>) =>
			fn.mock.calls
				.map((c) => c[0] as { type?: string })
				.filter((m) => m.type === 'task.assigned').length
		expect(sentAssign(aSent)).toBe(0)
		expect(sentAssign(bSent)).toBe(0)
		expect(rig.jobStore.listPending()).toHaveLength(1)

		// Trying to dispatch one to 'a' immediately must NOT claim — same-login,
		// other-login still connected (busy).
		const aSnap = rig.registry.list().find((m) => m.memberName === 'a')!
		rig.dispatcher.tryDispatchOne(aSnap)
		expect(sentAssign(aSent)).toBe(0)

		// Advance past the 10-minute fallback window.
		vi.setSystemTime(new Date('2026-05-03T00:11:00Z'))
		rig.dispatcher.tryDispatchOne(aSnap)
		expect(sentAssign(aSent)).toBeGreaterThan(0)
	})

	it('respects member.repos allowlist when picking up tasks', () => {
		const aSent = vi.fn()
		// Member with allowlist [o/other] won't see o/r task.
		rig.registry.add(
			fakeMember({
				memberName: 'a',
				status: 'idle',
				send: aSent,
				repos: ['o/other'],
			}),
		)
		const task = rig.taskStore.create({
			kind: 'implement',
			title: 't',
			description: 'd',
			repo: 'o/r',
		})
		void task
		const m = rig.registry.list()[0]!
		rig.dispatcher.tryDispatchOne(m)
		expect(aSent).not.toHaveBeenCalled()
	})

	it('uses persisted pr_author_login column when present', () => {
		const aSent = vi.fn()
		const bSent = vi.fn()
		rig.registry.add(fakeMember({ memberName: 'a', status: 'idle', send: aSent }))
		rig.registry.add(fakeMember({ memberName: 'b', status: 'idle', send: bSent }))
		// Implement task is currently assigned to 'b' (e.g. after changes_requested
		// and a re-implement), but the original PR author was 'a' — captured on
		// the row's `pr_author_login` column. Review must NOT go to 'a'.
		const task = rig.taskStore.create({
			kind: 'implement',
			title: 't',
			description: 'd',
			repo: 'o/r',
		})
		rig.taskStore.setPrAuthorLogin(task.id, 'a')
		rig.taskStore.clearAssignment(task.id)
		const b = rig.registry.list().find((m) => m.memberName === 'b')!
		const claimed = rig.taskStore.claimNextFor(['implement'], {
			sessionId: b.sessionId,
			memberId: b.memberId,
		})!
		rig.taskStore.transition(claimed.id, ['assigned'], 'in-progress', {
			prUrl: `https://github.com/o/r/pull/1`,
		})

		rig.dispatcher.dispatchReviewJobsFor(rig.taskStore.get(claimed.id)!)

		const sentAssign = (fn: ReturnType<typeof vi.fn>) =>
			fn.mock.calls
				.map((c) => c[0] as { type?: string })
				.filter((m) => m.type === 'task.assigned').length
		// 'b' (current assignee != PR author 'a') should get the review.
		expect(sentAssign(bSent)).toBeGreaterThan(0)
		// 'a' must not — they're the real PR author.
		expect(sentAssign(aSent)).toBe(0)
	})
})

describe('Dispatcher review-job republish', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => rig.cleanup())

	function captureUpdates(taskId: string): Array<{
		pending: number
		inProgress: number
		completed: number
		failed: number
	} | null> {
		const seen: Array<ReturnType<typeof rig.taskStore.get>> = []
		rig.taskStore.on((event) => {
			if (event.type === 'task.updated' && event.task.id === taskId) {
				seen.push(event.task)
			}
		})
		return new Proxy(seen as never, {
			get(target, prop) {
				if (prop === 'length') return seen.length
				const idx = Number(prop)
				if (Number.isFinite(idx)) return seen[idx]?.reviewJobs ?? null
				return Reflect.get(target, prop)
			},
		}) as Array<{
			pending: number
			inProgress: number
			completed: number
			failed: number
		} | null>
	}

	it('emits task.updated with a fresh reviewJobs summary when a review job is dispatched', () => {
		// Two distinct logins so the dispatcher actually sends a job out.
		rig.registry.add(fakeMember({ memberName: 'b', status: 'idle' }))
		const task = createReadyImplementTask(rig, { repo: 'o/r', assignedMemberName: 'a' })

		const reviewJobsHistory = captureUpdates(task.id)
		rig.dispatcher.dispatchReviewJobsFor(task)

		// At least one task.updated fired during dispatch, and the latest summary
		// reflects the assigned (= inProgress in our bucketing) review job.
		expect(reviewJobsHistory.length).toBeGreaterThan(0)
		const latest = reviewJobsHistory[reviewJobsHistory.length - 1]
		expect(latest?.inProgress).toBeGreaterThan(0)
	})

	it('emits task.updated when a review job completes', () => {
		rig.registry.add(fakeMember({ memberName: 'b', status: 'idle' }))
		const task = createReadyImplementTask(rig, { repo: 'o/r', assignedMemberName: 'a' })
		rig.dispatcher.dispatchReviewJobsFor(task)
		const job = rig.jobStore.listByTask(task.id)[0]!

		const reviewJobsHistory = captureUpdates(task.id)
		rig.dispatcher.onCompleted(job.id, { verdict: 'approved' }, null)

		expect(reviewJobsHistory.length).toBeGreaterThan(0)
		const latest = reviewJobsHistory[reviewJobsHistory.length - 1]
		expect(latest?.completed).toBe(1)
		expect(latest?.inProgress).toBe(0)
	})

	it('emits task.updated when a review job fails', () => {
		rig.registry.add(fakeMember({ memberName: 'b', status: 'idle' }))
		const task = createReadyImplementTask(rig, { repo: 'o/r', assignedMemberName: 'a' })
		rig.dispatcher.dispatchReviewJobsFor(task)
		const job = rig.jobStore.listByTask(task.id)[0]!

		const reviewJobsHistory = captureUpdates(task.id)
		rig.dispatcher.onFailed(job.id, 'agent_error')

		expect(reviewJobsHistory.length).toBeGreaterThan(0)
		const latest = reviewJobsHistory[reviewJobsHistory.length - 1]
		expect(latest?.failed).toBe(1)
		expect(latest?.inProgress).toBe(0)
	})
})

describe('Dispatcher triage → implement spawning', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => rig.cleanup())

	function startTriage(opts: { repo: string; issueNumber: number }): {
		triageId: string
		member: ConnectedMember
	} {
		// Day-mode member: only `triage`. So the freshly-spawned implement
		// task can't be claimed by anyone in this test, and we can assert
		// it stays in `queued`.
		const member = fakeMember({ memberName: 't-runner', status: 'idle', skills: ['triage'] })
		rig.registry.add(member)
		const task = rig.taskStore.create({
			kind: 'triage',
			title: 'Make widget faster',
			description: 'Improve perf',
			repo: opts.repo,
			githubIssueNumber: opts.issueNumber,
			githubIssueUrl: `https://github.com/${opts.repo}/issues/${opts.issueNumber}`,
		})
		const claimed = rig.taskStore.claimNextFor(['triage'], {
			sessionId: member.sessionId,
			memberId: member.memberId,
		})!
		expect(claimed.id).toBe(task.id)
		rig.taskStore.transition(claimed.id, ['assigned'], 'in-progress', {})
		return { triageId: claimed.id, member }
	}

	it('plan outcome spawns an implement task for the same issue and stores the size', () => {
		const { triageId } = startTriage({ repo: 'o/r', issueNumber: 42 })

		rig.dispatcher.onCompleted(triageId, { outcome: 'plan', size: 'M' }, null)

		// Triage task itself moves to `done`.
		expect(rig.taskStore.get(triageId)?.status).toBe('done')

		// A new `implement` task exists for the same issue, in `queued`, with
		// the size from the plan output.
		const all = rig.taskStore.list({ repo: 'o/r' })
		const implement = all.find((t) => t.kind === 'implement')
		expect(implement).toBeDefined()
		expect(implement?.status).toBe('queued')
		expect(implement?.planSize).toBe('M')
		expect(implement?.githubIssueNumber).toBe(42)
		expect(
			(implement?.metadata as Record<string, unknown> | null)?.['spawned_from_triage'],
		).toBe(triageId)
	})

	it('question outcome does NOT spawn an implement task', () => {
		const { triageId } = startTriage({ repo: 'o/r', issueNumber: 43 })

		rig.dispatcher.onCompleted(triageId, { outcome: 'question' }, null)

		expect(rig.taskStore.get(triageId)?.status).toBe('done')
		const all = rig.taskStore.list({ repo: 'o/r' })
		expect(all.find((t) => t.kind === 'implement')).toBeUndefined()
	})

	it('does not spawn a duplicate implement when one is already in flight for the issue', () => {
		const { triageId } = startTriage({ repo: 'o/r', issueNumber: 44 })
		// Pre-existing implement task for the same issue (e.g. from a prior triage).
		rig.taskStore.create({
			kind: 'implement',
			title: 'pre-existing',
			description: '',
			repo: 'o/r',
			githubIssueNumber: 44,
		})

		rig.dispatcher.onCompleted(triageId, { outcome: 'plan', size: 'L' }, null)

		const implements_ = rig.taskStore
			.list({ repo: 'o/r' })
			.filter((t) => t.kind === 'implement')
		expect(implements_).toHaveLength(1)
		// And the one that's there is the original — not overwritten.
		expect(implements_[0]?.title).toBe('pre-existing')
	})
})

describe('Dispatcher preferred-member bias', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => rig.cleanup())

	function queuedTaskPreferredBy(memberId: string, repo: string) {
		const task = rig.taskStore.create({
			kind: 'implement',
			title: 't',
			description: 'd',
			repo,
		})
		// `previous_member_id` is the dispatcher's "first dibs" hint, set when
		// a task returns to `queued` from changes_requested or auto-retry.
		rig.taskStore.stampPreviousMember(task.id, memberId)
		return rig.taskStore.get(task.id)!
	}

	it('idle original assignee claims their own queued task before generic ones', () => {
		const aSent = vi.fn()
		const bSent = vi.fn()
		const a = fakeMember({ memberName: 'a', status: 'idle', send: aSent })
		const b = fakeMember({ memberName: 'b', status: 'idle', send: bSent })
		rig.registry.add(a)
		rig.registry.add(b)

		// Older generic queued task; newer queued task pre-assigned to 'a'.
		rig.taskStore.create({
			kind: 'implement',
			title: 'generic',
			description: '',
			repo: 'o/r',
		})
		const preferred = queuedTaskPreferredBy(a.memberId, 'o/r')

		rig.dispatcher.tryDispatchAll()

		const sentTaskIds = (fn: ReturnType<typeof vi.fn>) =>
			fn.mock.calls
				.map((c) => c[0] as { type?: string; task?: { task_id: string } })
				.filter((m) => m.type === 'task.assigned')
				.map((m) => m.task?.task_id)
		expect(sentTaskIds(aSent)).toContain(preferred.id)
		// 'b' must not have grabbed the preferred task.
		expect(sentTaskIds(bSent)).not.toContain(preferred.id)
	})

	it('falls back to the generic queue when the original assignee is offline', () => {
		// 'a' connects (so its row lands in the members table for the FK target),
		// then disconnects. The queued task still references 'a' but 'a' is gone.
		const a = fakeMember({ memberName: 'a' })
		rig.registry.add(a)
		rig.registry.remove(a.sessionId)

		const bSent = vi.fn()
		const b = fakeMember({ memberName: 'b', status: 'idle', send: bSent })
		rig.registry.add(b)

		const orphaned = queuedTaskPreferredBy(a.memberId, 'o/r')

		rig.dispatcher.tryDispatchAll()

		const sentTaskIds = bSent.mock.calls
			.map((c) => c[0] as { type?: string; task?: { task_id: string } })
			.filter((m) => m.type === 'task.assigned')
			.map((m) => m.task?.task_id)
		// 'b' picks up the orphaned task via the generic claim path.
		expect(sentTaskIds).toContain(orphaned.id)
	})

	it('falls back to the generic queue when the original assignee is busy', () => {
		const aSent = vi.fn()
		const bSent = vi.fn()
		const a = fakeMember({ memberName: 'a', status: 'busy', send: aSent })
		const b = fakeMember({ memberName: 'b', status: 'idle', send: bSent })
		rig.registry.add(a)
		rig.registry.add(b)
		const preferred = queuedTaskPreferredBy(a.memberId, 'o/r')

		rig.dispatcher.tryDispatchAll()

		const sentTaskIds = (fn: ReturnType<typeof vi.fn>) =>
			fn.mock.calls
				.map((c) => c[0] as { type?: string; task?: { task_id: string } })
				.filter((m) => m.type === 'task.assigned')
				.map((m) => m.task?.task_id)
		// 'a' is busy; 'b' steps in.
		expect(sentTaskIds(bSent)).toContain(preferred.id)
		expect(sentTaskIds(aSent)).not.toContain(preferred.id)
	})
})

describe('Dispatcher daily-budget bias', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => rig.cleanup())

	function seedUsage(rig: Rig, memberId: string, taskId: string, tokens: number): void {
		const sqlite = (
			rig.taskStore as unknown as { db: { $client: import('better-sqlite3').Database } }
		).db.$client
		sqlite
			.prepare(
				'INSERT INTO members (member_id, member_name, display_name) VALUES (?, ?, ?)' +
					' ON CONFLICT(member_id) DO NOTHING',
			)
			.run(memberId, memberId, memberId)
		sqlite
			.prepare(
				'INSERT INTO task_events (task_id, seq, ts, session_id, member_id, kind, payload)' +
					' VALUES (?, ?, ?, NULL, ?, ?, ?)',
			)
			.run(
				taskId,
				1,
				Date.now(),
				memberId,
				'usage',
				JSON.stringify({ input: tokens, output: 0 }),
			)
	}

	const sentAssign = (fn: ReturnType<typeof vi.fn>) =>
		fn.mock.calls
			.map((c) => c[0] as { type?: string })
			.filter((m) => m.type === 'task.assigned').length

	it('with equal caps, prefers the member who has used less of their budget', () => {
		const aSent = vi.fn()
		const bSent = vi.fn()
		const a = fakeMember({
			memberName: 'a',
			status: 'idle',
			send: aSent,
			maxTokensPerDay: 1_000_000,
		})
		const b = fakeMember({
			memberName: 'b',
			status: 'idle',
			send: bSent,
			maxTokensPerDay: 1_000_000,
		})
		rig.registry.add(a)
		rig.registry.add(b)
		// a at 10% of cap; b at 0.5%.
		seedUsage(rig, a.memberId, 'past-task-a', 100_000)
		seedUsage(rig, b.memberId, 'past-task-b', 5_000)

		rig.taskStore.create({ kind: 'implement', title: 't', description: 'd', repo: 'o/r' })
		rig.dispatcher.tryDispatchAll()

		expect(sentAssign(bSent)).toBe(1)
		expect(sentAssign(aSent)).toBe(0)
	})

	it('with unequal caps, ranks by percentage so a small-cap member is not drained first', () => {
		// Scenario: a has a generous cap (1M, used 100k → 10%). b has a tight
		// cap (50k, used 10k → 20%). Absolute-spend ordering would pick b
		// (10k < 100k); percentage ordering correctly picks a (10% < 20%) so
		// b's smaller daily budget isn't blown through first.
		const aSent = vi.fn()
		const bSent = vi.fn()
		const a = fakeMember({
			memberName: 'a',
			status: 'idle',
			send: aSent,
			maxTokensPerDay: 1_000_000,
		})
		const b = fakeMember({
			memberName: 'b',
			status: 'idle',
			send: bSent,
			maxTokensPerDay: 50_000,
		})
		rig.registry.add(a)
		rig.registry.add(b)
		seedUsage(rig, a.memberId, 'past-task-a', 100_000)
		seedUsage(rig, b.memberId, 'past-task-b', 10_000)

		rig.taskStore.create({ kind: 'implement', title: 't', description: 'd', repo: 'o/r' })
		rig.dispatcher.tryDispatchAll()

		expect(sentAssign(aSent)).toBe(1)
		expect(sentAssign(bSent)).toBe(0)
	})

	it('treats a member with no cap as having unlimited headroom (fraction 0)', () => {
		// a: uncapped (null), so fraction = 0 even after spending.
		// b: capped at 50k with 10k used (20%). a wins.
		const aSent = vi.fn()
		const bSent = vi.fn()
		const a = fakeMember({
			memberName: 'a',
			status: 'idle',
			send: aSent,
			maxTokensPerDay: null,
		})
		const b = fakeMember({
			memberName: 'b',
			status: 'idle',
			send: bSent,
			maxTokensPerDay: 50_000,
		})
		rig.registry.add(a)
		rig.registry.add(b)
		seedUsage(rig, a.memberId, 'past-task-a', 500_000)
		seedUsage(rig, b.memberId, 'past-task-b', 10_000)

		rig.taskStore.create({ kind: 'implement', title: 't', description: 'd', repo: 'o/r' })
		rig.dispatcher.tryDispatchAll()

		expect(sentAssign(aSent)).toBe(1)
		expect(sentAssign(bSent)).toBe(0)
	})
})

describe('Dispatcher rebase routing', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	it('a Member with `implement` skill claims a `rebase` task', () => {
		const sent = vi.fn()
		const member = fakeMember({
			memberName: 'a',
			status: 'idle',
			send: sent,
			skills: ['implement'],
		})
		rig.registry.add(member)
		const rebase = rig.taskStore.create({
			kind: 'rebase',
			title: 'Rebase: foo',
			description: 'rebase me',
			repo: 'o/r',
			metadata: { head_ref: 'pr/night/abc-foo', base_ref: 'main' },
		})

		rig.dispatcher.tryDispatchAll()

		const sentRebase = sent.mock.calls
			.map((c) => c[0] as { type?: string; task?: { task_id: string; kind: string } })
			.find((m) => m.type === 'task.assigned' && m.task?.task_id === rebase.id)
		expect(sentRebase).toBeDefined()
		expect(sentRebase!.task!.kind).toBe('rebase')
	})

	it('a Member without `implement` skill never claims a `rebase` task', () => {
		const sent = vi.fn()
		const member = fakeMember({
			memberName: 'a',
			status: 'idle',
			send: sent,
			skills: ['review', 'triage'], // no implement
		})
		rig.registry.add(member)
		rig.taskStore.create({
			kind: 'rebase',
			title: 'Rebase: foo',
			description: 'rebase me',
			repo: 'o/r',
			metadata: { head_ref: 'pr/night/abc-foo', base_ref: 'main' },
		})

		rig.dispatcher.tryDispatchAll()

		const taskAssigns = sent.mock.calls
			.map((c) => c[0] as { type?: string })
			.filter((m) => m.type === 'task.assigned')
		expect(taskAssigns).toHaveLength(0)
	})

	it('prefers the original implementer (previousMemberId) over a generic implement Member', () => {
		const aSent = vi.fn()
		const bSent = vi.fn()
		const a = fakeMember({
			memberName: 'a',
			status: 'idle',
			send: aSent,
			skills: ['implement'],
		})
		const b = fakeMember({
			memberName: 'b',
			status: 'idle',
			send: bSent,
			skills: ['implement'],
		})
		rig.registry.add(a)
		rig.registry.add(b)
		const rebase = rig.taskStore.create({
			kind: 'rebase',
			title: 'Rebase: foo',
			description: 'rebase me',
			repo: 'o/r',
			metadata: { head_ref: 'pr/night/abc-foo', base_ref: 'main' },
		})
		rig.taskStore.stampPreviousMember(rebase.id, a.memberId)

		rig.dispatcher.tryDispatchAll()

		const sentTo = (fn: ReturnType<typeof vi.fn>) =>
			fn.mock.calls
				.map((c) => c[0] as { type?: string; task?: { task_id: string } })
				.filter((m) => m.type === 'task.assigned' && m.task?.task_id === rebase.id)
		expect(sentTo(aSent)).toHaveLength(1)
		expect(sentTo(bSent)).toHaveLength(0)
	})
})
