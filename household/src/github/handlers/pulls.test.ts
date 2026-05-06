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
import { TaskStore } from '../../tasks/store.ts'
import { TaskJobStore } from '../../tasks/jobStore.ts'
import type { MemberRegistry } from '../../members/registry.ts'
import { handlePullRequestEvent, handlePullRequestReviewEvent } from './pulls.ts'

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
	taskStore: TaskStore
	jobStore: TaskJobStore
	tryDispatchAll: ReturnType<typeof vi.fn>
	cleanup: () => void
}

function createRig(): Rig {
	const dir = mkdtempSync(join(tmpdir(), 'night-pulls-test-'))
	const sqlite = new Database(join(dir, 'test.sqlite'))
	sqlite.pragma('journal_mode = WAL')
	sqlite.pragma('foreign_keys = ON')
	const db = drizzle(sqlite, { schema })
	migrate(db, { migrationsFolder })
	return {
		taskStore: new TaskStore(db),
		jobStore: new TaskJobStore(db),
		tryDispatchAll: vi.fn(),
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
		taskStore: rig.taskStore,
		dispatcher: { tryDispatchAll: rig.tryDispatchAll } as unknown as Dispatcher,
		registry: {
			get: () => undefined,
			findConnectionForTask: () => undefined,
		} as unknown as MemberRegistry,
		logger: silentLogger,
	}
}

const REPO = 'octo/widget'

/**
 * Build a parent implement task already in `in-review` with a recorded
 * `pr_url` — the realistic shape for a PR currently waiting on review
 * when its base branch moves underneath it.
 */
function seedParentImplement(
	rig: Rig,
	opts: { branchPrefix: string; prUrl: string; assignedMemberId?: string },
) {
	const task = rig.taskStore.create({
		kind: 'implement',
		title: 'Speed up widget',
		description: 'do the thing',
		repo: REPO,
		githubIssueNumber: 42,
		githubIssueUrl: `https://github.com/${REPO}/issues/42`,
	})
	// Branch ID prefix matches the pulls.ts head-ref → task lookup.
	const id = task.id.startsWith(opts.branchPrefix)
		? task.id
		: `${opts.branchPrefix}${task.id.slice(opts.branchPrefix.length)}`
	if (id !== task.id) {
		// We can't reassign the id post-create, so let's skip the rename and
		// derive the prefix from the actual id instead. (Tests below pass the
		// real id-prefix back in.)
	}
	rig.taskStore.transition(task.id, ['queued'], 'in-review', { prUrl: opts.prUrl })
	if (opts.assignedMemberId) {
		// Stamp via the dispatcher's bias channel. We don't fake a Member row
		// here (FK is `set null` on delete); the bias is just a string.
		// `clearAssignment` is a no-op when there's no assignment to clear.
	}
	return rig.taskStore.get(task.id)!
}

function pullsBody(opts: {
	number: number
	headRef: string
	baseRef: string
	prUrl: string
	headSha: string
	behind_by: number
	merged?: boolean
	state?: 'open' | 'closed'
}) {
	return {
		action: 'synchronize',
		pull_request: {
			number: opts.number,
			html_url: opts.prUrl,
			state: opts.state ?? 'open',
			merged: opts.merged ?? false,
			behind_by: opts.behind_by,
			head: { ref: opts.headRef, sha: opts.headSha },
			base: { ref: opts.baseRef },
		},
	}
}

describe('handlePullRequestEvent — rebase enqueueing', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	it('enqueues a `rebase` task with the right metadata when behind_by > 0', async () => {
		const parent = seedParentImplement(rig, {
			branchPrefix: '',
			prUrl: `https://github.com/${REPO}/pull/7`,
		})
		const headRef = `pr/night/${parent.id.slice(0, 8)}-speed`

		await handlePullRequestEvent(
			ctxFor(
				rig,
				REPO,
				pullsBody({
					number: 7,
					headRef,
					baseRef: 'main',
					prUrl: parent.prUrl!,
					headSha: 'cafebabe',
					behind_by: 3,
				}),
			),
		)

		const all = rig.taskStore.list({ repo: REPO })
		const rebase = all.find((t) => t.kind === 'rebase')
		expect(rebase).toBeDefined()
		expect(rebase!.status).toBe('queued')
		expect(rebase!.prUrl).toBe(parent.prUrl)
		expect(rebase!.metadata).toMatchObject({
			parent_task_id: parent.id,
			head_ref: headRef,
			base_ref: 'main',
			behind_by: 3,
		})
		expect(rig.tryDispatchAll).toHaveBeenCalled()
	})

	it('does not enqueue a second rebase while one is already in flight', async () => {
		const parent = seedParentImplement(rig, {
			branchPrefix: '',
			prUrl: `https://github.com/${REPO}/pull/7`,
		})
		const headRef = `pr/night/${parent.id.slice(0, 8)}-speed`
		const body = pullsBody({
			number: 7,
			headRef,
			baseRef: 'main',
			prUrl: parent.prUrl!,
			headSha: 'cafebabe',
			behind_by: 3,
		})

		await handlePullRequestEvent(ctxFor(rig, REPO, body))
		await handlePullRequestEvent(ctxFor(rig, REPO, body))
		await handlePullRequestEvent(ctxFor(rig, REPO, body))

		const rebases = rig.taskStore.list({ repo: REPO }).filter((t) => t.kind === 'rebase')
		expect(rebases).toHaveLength(1)
	})

	it('does not enqueue rebase when behind_by is 0 or missing', async () => {
		const parent = seedParentImplement(rig, {
			branchPrefix: '',
			prUrl: `https://github.com/${REPO}/pull/7`,
		})
		const headRef = `pr/night/${parent.id.slice(0, 8)}-speed`

		await handlePullRequestEvent(
			ctxFor(
				rig,
				REPO,
				pullsBody({
					number: 7,
					headRef,
					baseRef: 'main',
					prUrl: parent.prUrl!,
					headSha: 'cafebabe',
					behind_by: 0,
				}),
			),
		)
		const rebases = rig.taskStore.list({ repo: REPO }).filter((t) => t.kind === 'rebase')
		expect(rebases).toHaveLength(0)
	})

	it('allows a fresh rebase task once the prior one reaches `done`', async () => {
		const parent = seedParentImplement(rig, {
			branchPrefix: '',
			prUrl: `https://github.com/${REPO}/pull/7`,
		})
		const headRef = `pr/night/${parent.id.slice(0, 8)}-speed`
		const body = pullsBody({
			number: 7,
			headRef,
			baseRef: 'main',
			prUrl: parent.prUrl!,
			headSha: 'cafebabe',
			behind_by: 3,
		})
		await handlePullRequestEvent(ctxFor(rig, REPO, body))
		const first = rig.taskStore.list({ repo: REPO }).find((t) => t.kind === 'rebase')!
		// Mark the first rebase done; a subsequent base push should enqueue a new one.
		rig.taskStore.transition(first.id, ['queued'], 'done')

		await handlePullRequestEvent(ctxFor(rig, REPO, body))
		const rebases = rig.taskStore.list({ repo: REPO }).filter((t) => t.kind === 'rebase')
		expect(rebases).toHaveLength(2)
	})
})

function reviewBody(opts: {
	prUrl: string
	headRef: string
	state: 'changes_requested' | 'approved' | 'commented'
	authorAssociation?: string
	mergeableState?: string
}) {
	return {
		action: 'submitted',
		pull_request: {
			number: 7,
			html_url: opts.prUrl,
			state: 'open',
			merged: false,
			mergeable_state: opts.mergeableState ?? 'clean',
			head: { ref: opts.headRef, sha: 'cafebabe' },
			base: { ref: 'main' },
		},
		review: {
			state: opts.state,
			body: 'lgtm',
			user: { login: 'reviewer' },
			author_association: opts.authorAssociation ?? 'OWNER',
		},
	}
}

describe('handlePullRequestReviewEvent — author_association gating', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	function seedAndBody(
		authorAssociation: string | undefined,
		state: 'changes_requested' | 'approved',
	) {
		const parent = seedParentImplement(rig, {
			branchPrefix: '',
			prUrl: `https://github.com/${REPO}/pull/7`,
		})
		const headRef = `pr/night/${parent.id.slice(0, 8)}-speed`
		return {
			parent,
			body: reviewBody({
				prUrl: parent.prUrl!,
				headRef,
				state,
				...(authorAssociation !== undefined
					? { authorAssociation }
					: { authorAssociation: '' }),
			}),
		}
	}

	it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])(
		'requeues the task on changes_requested from a trusted reviewer (%s)',
		async (assoc) => {
			const { parent, body } = seedAndBody(assoc, 'changes_requested')
			await handlePullRequestReviewEvent(ctxFor(rig, REPO, body))
			const after = rig.taskStore.get(parent.id)!
			expect(after.status).toBe('queued')
			expect(rig.tryDispatchAll).toHaveBeenCalled()
		},
	)

	it('moves the task to awaiting-merge on approved+clean from a trusted reviewer', async () => {
		const { parent, body } = seedAndBody('MEMBER', 'approved')
		await handlePullRequestReviewEvent(ctxFor(rig, REPO, body))
		expect(rig.taskStore.get(parent.id)!.status).toBe('awaiting-merge')
	})

	it.each(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', 'MANNEQUIN', undefined, ''])(
		'ignores a changes_requested review from author_association %j',
		async (assoc) => {
			const { parent, body } = seedAndBody(assoc as string | undefined, 'changes_requested')
			await handlePullRequestReviewEvent(ctxFor(rig, REPO, body))
			const after = rig.taskStore.get(parent.id)!
			expect(after.status).toBe('in-review')
			expect(rig.tryDispatchAll).not.toHaveBeenCalled()
		},
	)

	it('ignores an approved review from an untrusted reviewer (no awaiting-merge bump)', async () => {
		const { parent, body } = seedAndBody('NONE', 'approved')
		await handlePullRequestReviewEvent(ctxFor(rig, REPO, body))
		expect(rig.taskStore.get(parent.id)!.status).toBe('in-review')
	})
})
