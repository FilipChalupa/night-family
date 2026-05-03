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
	const registry = new MemberRegistry()
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
}): ConnectedMember {
	const sessionId = `sess-${opts.memberName}-${Math.random().toString(16).slice(2, 8)}`
	return {
		sessionId,
		memberId: `mid-${sessionId}`,
		memberName: opts.memberName,
		displayName: opts.memberName,
		skills: ['implement', 'review', 'estimate'],
		repos: opts.repos ?? null,
		provider: 'anthropic',
		model: 'm',
		workerProfile: 'medium',
		protocolVersion: '2.0.0',
		tokenId: 'tok',
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
		skipEstimate: true,
	})
	rig.taskStore.transition(task.id, ['queued'], 'assigned', {})
	rig.taskStore.transition(task.id, ['assigned'], 'in-progress', {})
	// Stash the assigned member name so dispatchReviewJobsFor can derive prAuthorLogin.
	const session = `sess-${opts.assignedMemberName}`
	rig.registry.add(fakeMember({ memberName: opts.assignedMemberName, status: 'busy' }))
	// Write assignment to DB so prAuthorLogin fallback works.
	const ts = rig.registry.list().find((m) => m.memberName === opts.assignedMemberName)!
	rig.taskStore.transition(task.id, ['in-progress'], 'in-progress', {})
	rig.taskStore as unknown as { db: { update: typeof drizzle } } // no-op narrowing
	// Use private DB through schema directly:
	rig.dispatcher // touch to keep var alive
	void session
	void ts
	// Simpler: re-create with an explicit DB raw update. Actually TaskStore exposes assigned fields only via claim functions.
	// Use claimNextFor with a fresh assignment to set assignedMemberName.
	rig.taskStore.transition(task.id, ['in-progress'], 'queued', {})
	rig.taskStore.clearAssignment(task.id)
	const claimed = rig.taskStore.claimNextFor(['implement'], {
		sessionId: session,
		memberId: `mid-${session}`,
		memberName: opts.assignedMemberName,
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
			skipEstimate: true,
		})
		void task
		const m = rig.registry.list()[0]!
		rig.dispatcher.tryDispatchOne(m)
		expect(aSent).not.toHaveBeenCalled()
	})

	it('uses persisted pr_author_login from metadata when present', () => {
		const aSent = vi.fn()
		const bSent = vi.fn()
		rig.registry.add(fakeMember({ memberName: 'a', status: 'idle', send: aSent }))
		rig.registry.add(fakeMember({ memberName: 'b', status: 'idle', send: bSent }))
		// Implement task is currently assigned to 'b' (e.g. after changes_requested
		// and a re-implement), but the original PR author was 'a' — captured in
		// metadata. Review must NOT go to 'a' (real PR author).
		const task = rig.taskStore.create({
			kind: 'implement',
			title: 't',
			description: 'd',
			repo: 'o/r',
			skipEstimate: true,
			metadata: { pr_author_login: 'a' },
		})
		rig.taskStore.clearAssignment(task.id)
		const claimed = rig.taskStore.claimNextFor(['implement'], {
			sessionId: 'sess-b',
			memberId: 'mid-b',
			memberName: 'b',
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
