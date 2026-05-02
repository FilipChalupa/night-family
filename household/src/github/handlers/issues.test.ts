import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../../db/schema.ts'
import type { Dispatcher } from '../../tasks/dispatcher.ts'
import { TaskStore, type TaskRecord } from '../../tasks/store.ts'
import type { MemberRegistry } from '../../members/registry.ts'
import { handleIssuesEvent } from './issues.ts'

const migrationsFolder = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'db',
	'migrations',
)

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
	store: TaskStore
	tryDispatchAll: ReturnType<typeof vi.fn>
	registryGet: ReturnType<typeof vi.fn>
	cleanup: () => void
}

function createRig(): Rig {
	const dir = mkdtempSync(join(tmpdir(), 'night-issues-test-'))
	const sqlite = new Database(join(dir, 'test.sqlite'))
	sqlite.pragma('journal_mode = WAL')
	sqlite.pragma('foreign_keys = ON')
	const db = drizzle(sqlite, { schema })
	migrate(db, { migrationsFolder })

	const store = new TaskStore(db)
	const tryDispatchAll = vi.fn()
	const registryGet = vi.fn().mockReturnValue(null)

	return {
		store,
		tryDispatchAll,
		registryGet,
		cleanup: () => {
			sqlite.close()
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

function ctxFor(rig: Rig, repo: string, body: Record<string, unknown>) {
	return {
		repo,
		body,
		taskStore: rig.store,
		dispatcher: { tryDispatchAll: rig.tryDispatchAll } as unknown as Dispatcher,
		registry: { get: rig.registryGet } as unknown as MemberRegistry,
		logger: silentLogger,
	}
}

const REPO = 'octo/widget'

const issue = (overrides: Partial<{ number: number; title: string; labels: string[] }>) => ({
	number: overrides.number ?? 42,
	title: overrides.title ?? 'Make widget faster',
	body: 'Issue body text',
	labels: (overrides.labels ?? ['night']).map((name) => ({ name })),
	html_url: `https://github.com/${REPO}/issues/${overrides.number ?? 42}`,
})

function findTask(rig: Rig, issueNumber: number): TaskRecord | undefined {
	return rig.store.list().find((t) => {
		const meta = t.metadata as Record<string, unknown> | null
		return meta?.['github_issue_number'] === issueNumber
	})
}

describe('handleIssuesEvent', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	it('imports a task when an issue is opened with the night label', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, { action: 'opened', issue: issue({ number: 1 }) }),
		)
		const t = findTask(rig, 1)
		expect(t).toBeDefined()
		expect(t!.kind).toBe('implement')
		expect(t!.status).toBe('new')
		expect(t!.repo).toBe(REPO)
		expect(rig.tryDispatchAll).toHaveBeenCalled()
	})

	it('imports when the night label is added later', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'labeled',
				issue: issue({ number: 2, labels: ['night'] }),
				label: { name: 'night' },
			}),
		)
		expect(findTask(rig, 2)?.status).toBe('new')
	})

	it('does NOT create a task when a non-night label is added', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'labeled',
				issue: issue({ number: 3, labels: ['bug'] }),
				label: { name: 'bug' },
			}),
		)
		expect(findTask(rig, 3)).toBeUndefined()
	})

	it('cancels the task when the night label is removed', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, { action: 'opened', issue: issue({ number: 4 }) }),
		)
		expect(findTask(rig, 4)?.status).toBe('new')

		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'unlabeled',
				issue: issue({ number: 4, labels: [] }),
				label: { name: 'night' },
			}),
		)
		const t = findTask(rig, 4)
		expect(t?.status).toBe('failed')
		expect(t?.failureReason).toBe('label_removed')
	})

	it('retries a failed task when the night label is re-added (no estimate yet)', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, { action: 'opened', issue: issue({ number: 5 }) }),
		)
		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'unlabeled',
				issue: issue({ number: 5, labels: [] }),
				label: { name: 'night' },
			}),
		)
		expect(findTask(rig, 5)?.status).toBe('failed')

		rig.tryDispatchAll.mockClear()
		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'labeled',
				issue: issue({ number: 5, labels: ['night'] }),
				label: { name: 'night' },
			}),
		)
		const t = findTask(rig, 5)
		expect(t?.status).toBe('new')
		expect(t?.failureReason).toBeNull()
		expect(t?.retryCount).toBe(0)
		expect(t?.assignedSessionId).toBeNull()
		expect(rig.tryDispatchAll).toHaveBeenCalled()
	})

	it('retries to queued (skipping estimate) when the failed task already has an estimateSize', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, { action: 'opened', issue: issue({ number: 6 }) }),
		)
		const initial = findTask(rig, 6)!
		rig.store.storeEstimateResult(initial.id, 'M', [])
		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'unlabeled',
				issue: issue({ number: 6, labels: [] }),
				label: { name: 'night' },
			}),
		)
		expect(findTask(rig, 6)?.status).toBe('failed')

		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'labeled',
				issue: issue({ number: 6, labels: ['night'] }),
				label: { name: 'night' },
			}),
		)
		const t = findTask(rig, 6)
		expect(t?.status).toBe('queued')
		expect(t?.estimateSize).toBe('M')
	})

	it('skips re-import / retry when an active task already exists for the issue', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, { action: 'opened', issue: issue({ number: 7 }) }),
		)
		const before = findTask(rig, 7)!
		const beforeUpdatedAt = before.updatedAt

		// Simulate same label event arriving twice.
		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'labeled',
				issue: issue({ number: 7, labels: ['night'] }),
				label: { name: 'night' },
			}),
		)
		const after = findTask(rig, 7)!
		expect(after.id).toBe(before.id)
		expect(after.status).toBe('new')
		expect(after.updatedAt).toBe(beforeUpdatedAt)
	})
})
