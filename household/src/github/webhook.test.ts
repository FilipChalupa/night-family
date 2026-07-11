import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema.ts'
import { webhookDeliveries } from '../db/schema.ts'
import type { MemberRegistry } from '../members/registry.ts'
import type { Dispatcher } from '../tasks/dispatcher.ts'
import type { TaskStore } from '../tasks/store.ts'
import type { RepoBindingStore } from './bindings.ts'
import { mountGithubWebhook, signWebhookBody } from './webhook.ts'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')
const SECRET = 'test-secret'
const REPO = 'o/r'

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

// A push to refs/heads/main reaches taskStore.list in handlePushEvent — the
// stub below can throw there to simulate a handler failure.
const PUSH_BODY = { repository: { full_name: REPO }, ref: 'refs/heads/main', deleted: false }

interface Harness {
	app: Hono
	db: ReturnType<typeof drizzle<typeof schema>>
	listCalls: () => number
	cleanup: () => void
}

function createHarness(opts: { failFirstListCall?: boolean } = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), 'night-webhook-test-'))
	const sqlite = new Database(join(dir, 'test.sqlite'))
	sqlite.pragma('journal_mode = WAL')
	const db = drizzle(sqlite, { schema })
	migrate(db, { migrationsFolder })

	let calls = 0
	const taskStore = {
		list: () => {
			calls += 1
			if (opts.failFirstListCall && calls === 1) throw new Error('boom')
			return []
		},
	} as unknown as TaskStore
	const bindings = {
		getWebhookSecret: (repo: string) => (repo === REPO ? SECRET : null),
	} as unknown as RepoBindingStore

	const app = new Hono()
	mountGithubWebhook(app, {
		db,
		bindings,
		taskStore,
		dispatcher: {} as unknown as Dispatcher,
		registry: {} as unknown as MemberRegistry,
		logger: silentLogger,
	})

	return {
		app,
		db,
		listCalls: () => calls,
		cleanup: () => {
			sqlite.close()
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

function post(app: Hono, delivery: string, event = 'push', bodyObj: unknown = PUSH_BODY) {
	const body = JSON.stringify(bodyObj)
	return app.request('/webhooks/github', {
		method: 'POST',
		headers: {
			'x-github-event': event,
			'x-github-delivery': delivery,
			'x-hub-signature-256': signWebhookBody(body, SECRET),
			'content-type': 'application/json',
		},
		body,
	})
}

describe('GitHub webhook idempotency', () => {
	let h: Harness
	afterEach(() => h.cleanup())

	it('records a successful delivery and dedups a redelivery of the same id', async () => {
		h = createHarness()
		const res1 = await post(h.app, 'D1')
		expect(res1.status).toBe(200)
		expect(await res1.json()).toMatchObject({ ok: true })

		const rows = h.db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, 'D1'))
			.all()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.processedAt).not.toBeNull()

		const callsAfterFirst = h.listCalls()
		const res2 = await post(h.app, 'D1')
		expect(res2.status).toBe(200)
		expect(await res2.json()).toMatchObject({ dedup: true })
		// The redelivery was deduped, not reprocessed — the handler didn't run.
		expect(h.listCalls()).toBe(callsAfterFirst)
	})

	it('deletes the delivery row on handler failure so a redelivery reprocesses', async () => {
		h = createHarness({ failFirstListCall: true })

		const res1 = await post(h.app, 'D1')
		expect(res1.status).toBe(500)
		// The idempotency row must be gone, otherwise the retry would be deduped.
		const afterFail = h.db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, 'D1'))
			.all()
		expect(afterFail).toHaveLength(0)

		// GitHub redelivers the same id — this time the handler succeeds and the
		// event is actually processed (not silently deduped): the handler runs
		// again (list called past the first, throwing call) and the row lands.
		const res2 = await post(h.app, 'D1')
		expect(res2.status).toBe(200)
		expect(h.listCalls()).toBeGreaterThan(1)
		const afterRetry = h.db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, 'D1'))
			.all()
		expect(afterRetry).toHaveLength(1)
		expect(afterRetry[0]?.processedAt).not.toBeNull()
	})

	it('rejects a bad HMAC signature with 401 and records nothing', async () => {
		h = createHarness()
		const body = JSON.stringify(PUSH_BODY)
		const res = await h.app.request('/webhooks/github', {
			method: 'POST',
			headers: {
				'x-github-event': 'push',
				'x-github-delivery': 'D-bad',
				'x-hub-signature-256': 'sha256=deadbeef',
				'content-type': 'application/json',
			},
			body,
		})
		expect(res.status).toBe(401)
		const rows = h.db.select().from(webhookDeliveries).all()
		expect(rows).toHaveLength(0)
	})
})
