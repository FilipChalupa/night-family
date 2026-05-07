import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema.ts'
import { members, taskEvents } from '../db/schema.ts'
import { TaskStore } from './store.ts'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

interface Rig {
	store: TaskStore
	db: ReturnType<typeof drizzle<typeof schema>>
	cleanup: () => void
}

function createRig(): Rig {
	const dir = mkdtempSync(join(tmpdir(), 'night-store-test-'))
	const sqlite = new Database(join(dir, 'test.sqlite'))
	sqlite.pragma('journal_mode = WAL')
	sqlite.pragma('foreign_keys = ON')
	const db = drizzle(sqlite, { schema })
	migrate(db, { migrationsFolder })
	return {
		store: new TaskStore(db),
		db,
		cleanup: () => {
			sqlite.close()
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

function insertMember(rig: Rig, memberId: string): void {
	rig.db
		.insert(members)
		.values({
			memberId,
			memberName: memberId,
			displayName: memberId,
		})
		.run()
}

function insertUsageEvent(
	rig: Rig,
	opts: { taskId: string; memberId: string; seq: number; tokens: number; ts: Date },
): void {
	rig.db
		.insert(taskEvents)
		.values({
			taskId: opts.taskId,
			seq: opts.seq,
			ts: opts.ts,
			sessionId: null,
			memberId: opts.memberId,
			kind: 'usage',
			payload: JSON.stringify({ input: opts.tokens, output: 0 }),
		})
		.run()
}

describe('TaskStore.tokensSpentTodayByMember', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => rig.cleanup())

	it('returns an empty map when no usage events exist', () => {
		const out = rig.store.tokensSpentTodayByMember()
		expect(out.size).toBe(0)
	})

	it('takes the MAX usage per (task, member) and SUMs across tasks per member', () => {
		insertMember(rig, 'm-a')
		insertMember(rig, 'm-b')
		// Two cumulative usage events on the same task → MAX wins (40k, not 10k+40k).
		insertUsageEvent(rig, {
			taskId: 't-1',
			memberId: 'm-a',
			seq: 1,
			tokens: 10_000,
			ts: new Date(),
		})
		insertUsageEvent(rig, {
			taskId: 't-1',
			memberId: 'm-a',
			seq: 2,
			tokens: 40_000,
			ts: new Date(),
		})
		insertUsageEvent(rig, {
			taskId: 't-2',
			memberId: 'm-a',
			seq: 1,
			tokens: 5_000,
			ts: new Date(),
		})
		insertUsageEvent(rig, {
			taskId: 't-3',
			memberId: 'm-b',
			seq: 1,
			tokens: 7_500,
			ts: new Date(),
		})

		const out = rig.store.tokensSpentTodayByMember()
		expect(out.get('m-a')).toBe(45_000)
		expect(out.get('m-b')).toBe(7_500)
	})

	it('ignores events from before UTC midnight today', () => {
		insertMember(rig, 'm-a')
		const yesterday = new Date()
		yesterday.setUTCDate(yesterday.getUTCDate() - 1)
		insertUsageEvent(rig, {
			taskId: 't-old',
			memberId: 'm-a',
			seq: 1,
			tokens: 99_999,
			ts: yesterday,
		})

		const out = rig.store.tokensSpentTodayByMember()
		expect(out.get('m-a')).toBeUndefined()
	})

	it('skips events with no member_id', () => {
		insertUsageEvent(rig, {
			taskId: 't-orphan',
			memberId: null as unknown as string,
			seq: 1,
			tokens: 1_000,
			ts: new Date(),
		})

		const out = rig.store.tokensSpentTodayByMember()
		expect(out.size).toBe(0)
	})
})
