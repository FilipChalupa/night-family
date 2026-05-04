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
import { handleIssueCommentEvent, handleIssuesEvent } from './issues.ts'

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

function findAllTasks(rig: Rig, issueNumber: number): TaskRecord[] {
	return rig.store.list().filter((t) => {
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

	it('queues a triage task when an issue is opened with the night label', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, { action: 'opened', issue: issue({ number: 1 }) }),
		)
		const t = findTask(rig, 1)
		expect(t).toBeDefined()
		expect(t!.kind).toBe('triage')
		expect(t!.status).toBe('queued') // skipEstimate → straight to queued
		expect(t!.repo).toBe(REPO)
		expect(rig.tryDispatchAll).toHaveBeenCalled()
	})

	it('queues triage when the night label is added later', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'labeled',
				issue: issue({ number: 2, labels: ['night'] }),
				label: { name: 'night' },
			}),
		)
		const t = findTask(rig, 2)
		expect(t?.kind).toBe('triage')
		expect(t?.status).toBe('queued')
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

	it('cancels the triage task when the night label is removed', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, { action: 'opened', issue: issue({ number: 4 }) }),
		)
		expect(findTask(rig, 4)?.status).toBe('queued')

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

	it('retries a failed triage when the night label is re-added', async () => {
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
		expect(t?.status).toBe('queued')
		expect(t?.failureReason).toBeNull()
		expect(t?.retryCount).toBe(0)
		expect(t?.assignedSessionId).toBeNull()
		expect(rig.tryDispatchAll).toHaveBeenCalled()
	})

	it('skips re-import / retry when an active triage already exists for the issue', async () => {
		await handleIssuesEvent(
			ctxFor(rig, REPO, { action: 'opened', issue: issue({ number: 7 }) }),
		)
		const before = findTask(rig, 7)!
		const beforeUpdatedAt = before.updatedAt

		await handleIssuesEvent(
			ctxFor(rig, REPO, {
				action: 'labeled',
				issue: issue({ number: 7, labels: ['night'] }),
				label: { name: 'night' },
			}),
		)
		const after = findTask(rig, 7)!
		expect(after.id).toBe(before.id)
		expect(after.status).toBe('queued')
		expect(after.updatedAt).toBe(beforeUpdatedAt)
	})
})

describe('handleIssueCommentEvent', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	const commentEvent = (overrides: {
		issueNumber: number
		commentBody?: string
		commentAuthor?: string
	}) => ({
		action: 'created',
		issue: issue({ number: overrides.issueNumber, labels: ['night'] }),
		comment: {
			body: overrides.commentBody ?? 'Hey, can you also add a status indicator?',
			user: { login: overrides.commentAuthor ?? 'human-user' },
		},
	})

	it('queues a fresh triage task when a human posts a comment', async () => {
		// Pretend the issue was opened earlier and triage already finished
		// (status: done) so a new comment isn't blocked by idempotence.
		const t = rig.store.create({
			kind: 'triage',
			title: 'x',
			description: 'y',
			repo: REPO,
			metadata: { github_issue_number: 8, github_issue_url: 'http://x/8' },
			skipEstimate: true,
		})
		rig.store.transition(t.id, ['queued'], 'assigned', {})
		rig.store.transition(t.id, ['assigned'], 'in-progress', {})
		rig.store.transition(t.id, ['in-progress'], 'done', {})

		await handleIssueCommentEvent(ctxFor(rig, REPO, commentEvent({ issueNumber: 8 })))

		const all = findAllTasks(rig, 8)
		expect(all).toHaveLength(2)
		expect(all.every((x) => x.kind === 'triage')).toBe(true)
		const fresh = all.find((x) => x.status === 'queued')
		expect(fresh).toBeDefined()
	})

	it('ignores a comment carrying our Night Family attribution marker', async () => {
		const before = rig.store.list().length
		await handleIssueCommentEvent(
			ctxFor(
				rig,
				REPO,
				commentEvent({
					issueNumber: 9,
					commentBody:
						'Sure, here is the plan...\n\n---\n🤖 …\n<!-- night-family:member=m1 task=t1 -->',
				}),
			),
		)
		expect(rig.store.list().length).toBe(before)
	})

	it('skips when the issue does not carry the night label', async () => {
		await handleIssueCommentEvent(
			ctxFor(rig, REPO, {
				action: 'created',
				issue: issue({ number: 10, labels: ['bug'] }),
				comment: { body: 'just a question', user: { login: 'human' } },
			}),
		)
		expect(findTask(rig, 10)).toBeUndefined()
	})

	it('respects the per-issue lifetime cap', async () => {
		// Pre-seed 20 triage records (no active ones — all done).
		for (let i = 0; i < 20; i++) {
			const t = rig.store.create({
				kind: 'triage',
				title: 'x',
				description: 'y',
				repo: REPO,
				metadata: { github_issue_number: 11, github_issue_url: 'http://x/11' },
				skipEstimate: true,
			})
			rig.store.transition(t.id, ['queued'], 'assigned', {})
			rig.store.transition(t.id, ['assigned'], 'in-progress', {})
			rig.store.transition(t.id, ['in-progress'], 'done', {})
		}
		const before = rig.store.list().length
		await handleIssueCommentEvent(ctxFor(rig, REPO, commentEvent({ issueNumber: 11 })))
		expect(rig.store.list().length).toBe(before)
	})
})
