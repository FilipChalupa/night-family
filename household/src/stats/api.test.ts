import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdminGuard } from '../auth/guard.ts'
import * as schema from '../db/schema.ts'
import type { SessionStore } from '../auth/sessions.ts'
import { mountStatsApi } from './api.ts'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

interface DailyResponseRow {
	date: string
	created: number
	completed: number
	failed: number
	tokens: number
}

interface StatsResponseBody {
	windowDays: number
	daily: DailyResponseRow[]
	statusBreakdown: Array<{ status: string; count: number }>
	byMember: Array<{ name: string; completed: number; failed: number; tokens: number }>
}

interface Rig {
	app: Hono
	sqlite: Database.Database
	cleanup: () => void
}

function createRig(): Rig {
	const dir = mkdtempSync(join(tmpdir(), 'night-stats-test-'))
	const dbPath = join(dir, 'test.sqlite')
	const sqlite = new Database(dbPath)
	sqlite.pragma('journal_mode = WAL')
	sqlite.pragma('foreign_keys = ON')
	const db = drizzle(sqlite, { schema })
	migrate(db, { migrationsFolder })

	const guard = new AdminGuard({} as unknown as SessionStore, false, false)
	const app = new Hono()
	mountStatsApi(app, { sqlite, guard, previewHub: { connectedCount: () => 0 } })

	return {
		app,
		sqlite,
		cleanup: () => {
			sqlite.close()
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

function todayUtcNoon(): number {
	const d = new Date()
	d.setUTCHours(12, 0, 0, 0)
	return d.getTime()
}

function insertTask(
	sqlite: Database.Database,
	opts: {
		id: string
		status: string
		member: string | null
		updatedAt: number
		kind?: string
	},
): void {
	let memberId: string | null = null
	if (opts.member !== null) {
		// Member name → stable synthetic member_id. Insert OR IGNORE so multiple
		// tasks for the same member share the same row.
		memberId = `mid-${opts.member}`
		sqlite
			.prepare(
				`INSERT OR IGNORE INTO members
				 (member_id, member_name, display_name, first_connected_at, last_connected_at, last_seen_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(memberId, opts.member, opts.member, opts.updatedAt, opts.updatedAt, opts.updatedAt)
	}
	sqlite
		.prepare(
			`INSERT INTO tasks (id, kind, title, description, status, assigned_member_id, created_at, updated_at, retry_count)
			 VALUES (?, ?, 'test', '', ?, ?, ?, ?, 0)`,
		)
		.run(
			opts.id,
			opts.kind ?? 'implement',
			opts.status,
			memberId,
			opts.updatedAt,
			opts.updatedAt,
		)
}

function insertUsage(
	sqlite: Database.Database,
	taskId: string,
	seq: number,
	payload: Record<string, unknown>,
): void {
	sqlite
		.prepare(
			`INSERT INTO task_events (task_id, seq, ts, kind, payload) VALUES (?, ?, ?, 'usage', ?)`,
		)
		.run(taskId, seq, Date.now(), JSON.stringify(payload))
}

describe('GET /api/stats/tasks — token aggregates', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	it('returns zeroed daily series and empty member list when DB is empty', async () => {
		const res = await rig.app.request('/api/stats/tasks?days=7')
		expect(res.status).toBe(200)
		const body = (await res.json()) as StatsResponseBody
		expect(body.windowDays).toBe(7)
		expect(body.daily).toHaveLength(7)
		for (const d of body.daily) {
			expect(d.created).toBe(0)
			expect(d.completed).toBe(0)
			expect(d.failed).toBe(0)
			expect(d.tokens).toBe(0)
		}
		expect(body.byMember).toEqual([])
	})

	it('uses MAX over usage events (running cumulative totals) per task', async () => {
		const today = todayUtcNoon()
		insertTask(rig.sqlite, { id: 't1', status: 'done', member: 'alice', updatedAt: today })
		insertUsage(rig.sqlite, 't1', 1, { input: 100, output: 50 })
		insertUsage(rig.sqlite, 't1', 2, { input: 300, output: 150 }) // final cumulative

		insertTask(rig.sqlite, { id: 't2', status: 'failed', member: 'bob', updatedAt: today })
		insertUsage(rig.sqlite, 't2', 1, { input: 80, output: 20 })

		const res = await rig.app.request('/api/stats/tasks?days=7')
		const body = (await res.json()) as StatsResponseBody

		const todaysRow = body.daily[body.daily.length - 1]!
		// 450 (t1 final) + 100 (t2 final) = 550
		expect(todaysRow.tokens).toBe(550)
		expect(todaysRow.completed).toBe(1)
		expect(todaysRow.failed).toBe(1)

		const byName = (n: string) => body.byMember.find((m) => m.name === n)
		expect(byName('alice')).toEqual({ name: 'alice', completed: 1, failed: 0, tokens: 450 })
		expect(byName('bob')).toEqual({ name: 'bob', completed: 0, failed: 1, tokens: 100 })
	})

	it('keeps tasks without usage events at 0 tokens (LEFT JOIN on member agg)', async () => {
		const today = todayUtcNoon()
		insertTask(rig.sqlite, { id: 't1', status: 'done', member: 'alice', updatedAt: today })

		const res = await rig.app.request('/api/stats/tasks?days=7')
		const body = (await res.json()) as StatsResponseBody

		// daily uses INNER JOIN, so a task without usage contributes nothing to tokens.
		const todaysRow = body.daily[body.daily.length - 1]!
		expect(todaysRow.completed).toBe(1)
		expect(todaysRow.tokens).toBe(0)

		// byMember uses LEFT JOIN — alice still appears with completed=1, tokens=0.
		expect(body.byMember).toEqual([{ name: 'alice', completed: 1, failed: 0, tokens: 0 }])
	})

	it('handles missing input/output keys via COALESCE', async () => {
		const today = todayUtcNoon()
		insertTask(rig.sqlite, { id: 't1', status: 'done', member: 'alice', updatedAt: today })
		insertUsage(rig.sqlite, 't1', 1, { input: 100 })
		insertUsage(rig.sqlite, 't1', 2, { output: 50 })

		const res = await rig.app.request('/api/stats/tasks?days=7')
		const body = (await res.json()) as StatsResponseBody

		// MAX over (100+0, 0+50) = 100
		expect(body.byMember[0]!.tokens).toBe(100)
	})

	it('excludes tasks outside the time window', async () => {
		const today = todayUtcNoon()
		const longAgo = today - 60 * 24 * 60 * 60 * 1000
		insertTask(rig.sqlite, { id: 'old', status: 'done', member: 'alice', updatedAt: longAgo })
		insertUsage(rig.sqlite, 'old', 1, { input: 999, output: 999 })

		const res = await rig.app.request('/api/stats/tasks?days=7')
		const body = (await res.json()) as StatsResponseBody

		const totals = body.daily.reduce((s, d) => s + d.tokens, 0)
		expect(totals).toBe(0)
		expect(body.byMember).toEqual([])
	})
})

describe('GET /api/stats/members/:memberId/tokens', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	it('sums MAX usage across every task ever assigned to the member', async () => {
		const today = todayUtcNoon()
		const longAgo = today - 60 * 24 * 60 * 60 * 1000
		insertTask(rig.sqlite, { id: 't1', status: 'done', member: 'alice', updatedAt: today })
		insertUsage(rig.sqlite, 't1', 1, { input: 100, output: 50 })
		insertUsage(rig.sqlite, 't1', 2, { input: 300, output: 150 })

		// Old task — outside any 30-day window but should still count for all-time.
		insertTask(rig.sqlite, {
			id: 't-old',
			status: 'failed',
			member: 'alice',
			updatedAt: longAgo,
		})
		insertUsage(rig.sqlite, 't-old', 1, { input: 70, output: 30 })

		// In-progress task — also counts.
		insertTask(rig.sqlite, {
			id: 't-running',
			status: 'in_progress',
			member: 'alice',
			updatedAt: today,
		})
		insertUsage(rig.sqlite, 't-running', 1, { input: 25, output: 25 })

		// Other member — must not leak in.
		insertTask(rig.sqlite, { id: 't-bob', status: 'done', member: 'bob', updatedAt: today })
		insertUsage(rig.sqlite, 't-bob', 1, { input: 999, output: 999 })

		const res = await rig.app.request('/api/stats/members/mid-alice/tokens')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { memberId: string; tokens: number }
		// 450 (t1) + 100 (t-old) + 50 (t-running) = 600
		expect(body).toEqual({ memberId: 'mid-alice', tokens: 600 })
	})

	it('returns 0 for a member with no tasks or no usage events', async () => {
		insertTask(rig.sqlite, {
			id: 't1',
			status: 'done',
			member: 'alice',
			updatedAt: todayUtcNoon(),
		})
		// No usage events at all.

		const res = await rig.app.request('/api/stats/members/mid-alice/tokens')
		const body = (await res.json()) as { memberId: string; tokens: number }
		expect(body).toEqual({ memberId: 'mid-alice', tokens: 0 })

		const unknown = await rig.app.request('/api/stats/members/mid-nobody/tokens')
		const unknownBody = (await unknown.json()) as { memberId: string; tokens: number }
		expect(unknownBody).toEqual({ memberId: 'mid-nobody', tokens: 0 })
	})
})

describe('GET /api/stats/task-tokens', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	it('returns per-task token totals using MAX of input+output', async () => {
		insertTask(rig.sqlite, {
			id: 't1',
			status: 'done',
			member: null,
			updatedAt: todayUtcNoon(),
		})
		insertUsage(rig.sqlite, 't1', 1, { input: 50, output: 25 })
		insertUsage(rig.sqlite, 't1', 2, { input: 200, output: 100 })

		const res = await rig.app.request('/api/stats/task-tokens')
		expect(res.status).toBe(200)
		const body = (await res.json()) as { tokens: Record<string, number> }
		expect(body.tokens).toEqual({ t1: 300 })
	})

	it('omits tasks without usage events', async () => {
		insertTask(rig.sqlite, {
			id: 't1',
			status: 'done',
			member: null,
			updatedAt: todayUtcNoon(),
		})

		const res = await rig.app.request('/api/stats/task-tokens')
		const body = (await res.json()) as { tokens: Record<string, number> }
		expect(body.tokens).toEqual({})
	})
})

describe('GET /api/stats/preview', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	it('counts running/queued previews and recent outcomes, ignoring non-previews', async () => {
		const now = todayUtcNoon()
		const p = (id: string, status: string, member: string | null) =>
			insertTask(rig.sqlite, { id, status, member, updatedAt: now, kind: 'preview' })
		p('p1', 'in-progress', 'm')
		p('p2', 'assigned', 'm')
		p('p3', 'queued', null)
		p('p4', 'done', 'm')
		p('p5', 'failed', 'm')
		insertTask(rig.sqlite, { id: 'i1', status: 'in-progress', member: 'm', updatedAt: now })

		const res = await rig.app.request('/api/stats/preview')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			running: number
			queued: number
			connectedTunnels: number
			recent: { created: number; done: number; failed: number }
		}
		expect(body.running).toBe(2)
		expect(body.queued).toBe(1)
		expect(body.connectedTunnels).toBe(0)
		expect(body.recent).toMatchObject({ created: 5, done: 1, failed: 1 })
	})

	it('aggregates wake/sleep activity and average wake latency', async () => {
		const now = todayUtcNoon()
		insertTask(rig.sqlite, {
			id: 'p1',
			status: 'in-progress',
			member: 'm',
			updatedAt: now,
			kind: 'preview',
		})
		const ev = rig.sqlite.prepare(
			`INSERT INTO task_events (task_id, seq, ts, kind, payload) VALUES (?, ?, ?, 'preview', ?)`,
		)
		ev.run('p1', 1, now, JSON.stringify({ state: 'slept' }))
		ev.run('p1', 2, now, JSON.stringify({ state: 'woke', wakeMs: 1000 }))
		ev.run('p1', 3, now, JSON.stringify({ state: 'woke', wakeMs: 3000 }))
		ev.run('p1', 4, now, JSON.stringify({ state: 'slept' }))

		const res = await rig.app.request('/api/stats/preview')
		const body = (await res.json()) as {
			recent: { wakes: number; sleeps: number; avgWakeMs: number | null }
		}
		expect(body.recent.wakes).toBe(2)
		expect(body.recent.sleeps).toBe(2)
		expect(body.recent.avgWakeMs).toBe(2000)
	})
})
