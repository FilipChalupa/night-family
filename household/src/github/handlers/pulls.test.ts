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
import { TaskJobStore } from '../../tasks/jobStore.ts'
import type { MemberRegistry } from '../../members/registry.ts'
import {
	handlePullRequestEvent,
	handlePullRequestReviewEvent,
	handlePushEvent,
	restartPreviewsForBranch,
	syncPrPreview,
	sweepStalePrsForRebase,
} from './pulls.ts'

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

	it('drops a malformed pull_request payload (missing head) without throwing', async () => {
		await handlePullRequestEvent(
			ctxFor(rig, REPO, {
				action: 'synchronize',
				pull_request: { number: 7, html_url: 'https://x/7', base: { ref: 'main' } },
			}),
		)
		expect(rig.taskStore.list({ repo: REPO })).toHaveLength(0)
		expect(rig.tryDispatchAll).not.toHaveBeenCalled()
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
	body?: string
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
			body: opts.body ?? 'lgtm',
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

describe('handlePullRequestReviewEvent — commented → respond', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	function seedParent() {
		return seedParentImplement(rig, {
			branchPrefix: '',
			prUrl: `https://github.com/${REPO}/pull/7`,
		})
	}
	function commented(
		parent: TaskRecord,
		opts: { authorAssociation?: string; body?: string } = {},
	) {
		return reviewBody({
			prUrl: parent.prUrl!,
			headRef: `pr/night/${parent.id.slice(0, 8)}-speed`,
			state: 'commented',
			authorAssociation: opts.authorAssociation ?? 'OWNER',
			...(opts.body !== undefined ? { body: opts.body } : {}),
		})
	}

	it('queues a respond task carrying the PR and reviewer comment, parent stays in-review', async () => {
		const parent = seedParent()
		await handlePullRequestReviewEvent(
			ctxFor(rig, REPO, commented(parent, { body: 'is this thread-safe?' })),
		)
		const respond = rig.taskStore.list({ repo: REPO }).find((t) => t.kind === 'respond')
		expect(respond).toBeDefined()
		expect(respond!.status).toBe('queued')
		expect(respond!.prUrl).toBe(parent.prUrl)
		expect(respond!.description).toContain('is this thread-safe?')
		expect(rig.taskStore.get(parent.id)!.status).toBe('in-review')
		expect(rig.tryDispatchAll).toHaveBeenCalled()
	})

	it('does not spawn a duplicate respond while one is in flight', async () => {
		const parent = seedParent()
		await handlePullRequestReviewEvent(ctxFor(rig, REPO, commented(parent)))
		await handlePullRequestReviewEvent(ctxFor(rig, REPO, commented(parent)))
		const responds = rig.taskStore.list({ repo: REPO }).filter((t) => t.kind === 'respond')
		expect(responds).toHaveLength(1)
	})

	it('ignores a commented review from an untrusted reviewer', async () => {
		const parent = seedParent()
		await handlePullRequestReviewEvent(
			ctxFor(rig, REPO, commented(parent, { authorAssociation: 'NONE' })),
		)
		expect(rig.taskStore.list({ repo: REPO }).some((t) => t.kind === 'respond')).toBe(false)
	})
})

describe('handlePushEvent — base-branch advance', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => rig.cleanup())

	function pushBody(opts: { ref: string; deleted?: boolean }) {
		return {
			ref: opts.ref,
			...(opts.deleted ? { deleted: true } : {}),
			repository: { full_name: REPO },
		}
	}

	/** Seed an open PR task with the head/base refs the push handler reads. */
	function seedOpenPr(prNumber: number, baseRef = 'main') {
		const parent = seedParentImplement(rig, {
			branchPrefix: '',
			prUrl: `https://github.com/${REPO}/pull/${prNumber}`,
		})
		rig.taskStore.mergeMetadata(parent.id, {
			head_ref: `pr/night/${parent.id.slice(0, 8)}-speed`,
			base_ref: baseRef,
		})
		return rig.taskStore.get(parent.id)!
	}

	function rebasesFor() {
		return rig.taskStore.list({ repo: REPO }).filter((t) => t.kind === 'rebase')
	}

	it('enqueues a rebase for an open PR whose base just advanced', async () => {
		seedOpenPr(7)
		await handlePushEvent(ctxFor(rig, REPO, pushBody({ ref: 'refs/heads/main' })))
		const rebases = rebasesFor()
		expect(rebases).toHaveLength(1)
		expect(rebases[0]!.metadata?.base_ref).toBe('main')
		expect(rig.tryDispatchAll).toHaveBeenCalled()
	})

	it('ignores pushes to a branch that is not any open PR base', async () => {
		seedOpenPr(7, 'main')
		await handlePushEvent(ctxFor(rig, REPO, pushBody({ ref: 'refs/heads/release' })))
		expect(rebasesFor()).toHaveLength(0)
	})

	it('ignores non-branch refs and branch deletions', async () => {
		seedOpenPr(7)
		await handlePushEvent(ctxFor(rig, REPO, pushBody({ ref: 'refs/tags/v1' })))
		await handlePushEvent(
			ctxFor(rig, REPO, pushBody({ ref: 'refs/heads/main', deleted: true })),
		)
		expect(rebasesFor()).toHaveLength(0)
	})

	it('does not enqueue when the PR task lacks head/base ref metadata', async () => {
		// in-review PR but refs never persisted (e.g. pre-upgrade task).
		seedParentImplement(rig, { branchPrefix: '', prUrl: `https://github.com/${REPO}/pull/9` })
		await handlePushEvent(ctxFor(rig, REPO, pushBody({ ref: 'refs/heads/main' })))
		expect(rebasesFor()).toHaveLength(0)
	})

	it('throttles a burst of pushes to one rebase via the cooldown', async () => {
		seedOpenPr(7)
		await handlePushEvent(ctxFor(rig, REPO, pushBody({ ref: 'refs/heads/main' })))
		// Second push lands seconds later, before the first rebase ran.
		await handlePushEvent(ctxFor(rig, REPO, pushBody({ ref: 'refs/heads/main' })))
		expect(rebasesFor()).toHaveLength(1)
	})
})

describe('sweepStalePrsForRebase — time-driven freshness', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => rig.cleanup())

	function seedOpenPr(prNumber: number) {
		const parent = seedParentImplement(rig, {
			branchPrefix: '',
			prUrl: `https://github.com/${REPO}/pull/${prNumber}`,
		})
		rig.taskStore.mergeMetadata(parent.id, {
			head_ref: `pr/night/${parent.id.slice(0, 8)}-speed`,
			base_ref: 'main',
		})
		return rig.taskStore.get(parent.id)!
	}

	const deps = (rig: Rig) => ({
		taskStore: rig.taskStore,
		dispatcher: { tryDispatchAll: rig.tryDispatchAll } as unknown as Dispatcher,
		logger: silentLogger,
	})

	it('enqueues a rebase for an open PR untouched past the stale threshold', () => {
		seedOpenPr(7)
		// Pretend "now" is an hour past the PR's last update.
		const future = Date.now() + 60 * 60 * 1000
		const enqueued = sweepStalePrsForRebase(deps(rig), 10 * 60 * 1000, future)
		expect(enqueued).toBe(1)
	})

	it('skips PRs touched more recently than the stale threshold', () => {
		seedOpenPr(7)
		const enqueued = sweepStalePrsForRebase(deps(rig), 60 * 60 * 1000, Date.now())
		expect(enqueued).toBe(0)
	})
})

describe('restartPreviewsForBranch — preview branch advance', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	const seedRunningPreview = (branch: string) => {
		const t = rig.taskStore.create({
			kind: 'preview',
			title: `Preview ${branch}`,
			description: '',
			repo: REPO,
			metadata: { branch },
		})
		rig.taskStore.transition(t.id, ['queued'], 'in-progress')
		return rig.taskStore.get(t.id)!
	}

	it('cancels the running preview and queues a fresh one for the branch', () => {
		const running = seedRunningPreview('feature-x')

		const restarted = restartPreviewsForBranch(ctxFor(rig, REPO, {}), 'feature-x')

		expect(restarted).toBe(1)
		// No live connection in the test rig → the running preview is failed out.
		expect(rig.taskStore.get(running.id)!.status).toBe('failed')
		// A fresh queued preview now targets the same branch.
		const queued = rig.taskStore
			.list({ status: ['queued'] })
			.filter((t) => t.kind === 'preview' && t.metadata?.['branch'] === 'feature-x')
		expect(queued).toHaveLength(1)
		expect(rig.tryDispatchAll).toHaveBeenCalled()
	})

	it('is a no-op when no preview targets the pushed branch', () => {
		seedRunningPreview('feature-x')
		const restarted = restartPreviewsForBranch(ctxFor(rig, REPO, {}), 'other-branch')
		expect(restarted).toBe(0)
		expect(rig.taskStore.list({ status: ['queued'] })).toHaveLength(0)
	})

	it('does not queue a second preview when one is already queued for the branch', () => {
		seedRunningPreview('feature-x')
		// A previously-queued restart that hasn't been picked up yet.
		rig.taskStore.create({
			kind: 'preview',
			title: 'Preview feature-x',
			description: '',
			repo: REPO,
			metadata: { branch: 'feature-x' },
		})

		restartPreviewsForBranch(ctxFor(rig, REPO, {}), 'feature-x')

		const queued = rig.taskStore
			.list({ status: ['queued'] })
			.filter((t) => t.kind === 'preview' && t.metadata?.['branch'] === 'feature-x')
		expect(queued).toHaveLength(1)
	})
})

describe('syncPrPreview — preview-on-PR via label', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => {
		rig.cleanup()
	})

	const pr = (opts: {
		number?: number
		ref?: string
		labels?: string[]
		state?: 'open' | 'closed'
		headRepo?: string | null
	}) => ({
		number: opts.number ?? 1,
		html_url: `https://github.com/${REPO}/pull/${opts.number ?? 1}`,
		state: opts.state ?? 'open',
		labels: (opts.labels ?? []).map((name) => ({ name })),
		head: {
			ref: opts.ref ?? 'feature-x',
			sha: 'abc',
			repo: opts.headRepo === null ? null : { full_name: opts.headRepo ?? REPO },
		},
		base: { ref: 'main' },
	})

	const previews = () => rig.taskStore.list({ repo: REPO }).filter((t) => t.kind === 'preview')

	it('enqueues a preview for a labelled, same-repo PR', () => {
		syncPrPreview(ctxFor(rig, REPO, {}), pr({ labels: ['preview'], ref: 'feature-x' }))
		const p = previews()
		expect(p).toHaveLength(1)
		expect(p[0]!.status).toBe('queued')
		expect(p[0]!.metadata).toMatchObject({ branch: 'feature-x', pr_number: 1 })
		expect(rig.tryDispatchAll).toHaveBeenCalled()
	})

	it('does nothing for a PR without the preview label', () => {
		syncPrPreview(ctxFor(rig, REPO, {}), pr({ labels: ['bug'] }))
		expect(previews()).toHaveLength(0)
	})

	it('never previews a fork PR even when labelled', () => {
		syncPrPreview(ctxFor(rig, REPO, {}), pr({ labels: ['preview'], headRepo: 'someone/fork' }))
		expect(previews()).toHaveLength(0)
	})

	it('is idempotent — a second labelled event does not stack previews', () => {
		const ctx = ctxFor(rig, REPO, {})
		syncPrPreview(ctx, pr({ labels: ['preview'] }))
		syncPrPreview(ctx, pr({ labels: ['preview'] }))
		expect(previews()).toHaveLength(1)
	})

	it('cancels a running preview when the label is removed', () => {
		const t = rig.taskStore.create({
			kind: 'preview',
			title: 'Preview feature-x',
			description: '',
			repo: REPO,
			metadata: { branch: 'feature-x' },
		})
		rig.taskStore.transition(t.id, ['queued'], 'in-progress')

		syncPrPreview(ctxFor(rig, REPO, {}), pr({ labels: [], ref: 'feature-x' }))

		expect(rig.taskStore.get(t.id)!.status).toBe('failed')
	})

	it('cancels the preview when the PR closes', () => {
		const t = rig.taskStore.create({
			kind: 'preview',
			title: 'Preview feature-x',
			description: '',
			repo: REPO,
			metadata: { branch: 'feature-x' },
		})
		rig.taskStore.transition(t.id, ['queued'], 'in-progress')

		syncPrPreview(ctxFor(rig, REPO, {}), pr({ labels: ['preview'], state: 'closed' }))

		expect(rig.taskStore.get(t.id)!.status).toBe('failed')
	})

	it('re-ensures the preview on a push (synchronize) to a labelled PR', async () => {
		await handlePullRequestEvent(
			ctxFor(rig, REPO, {
				action: 'synchronize',
				pull_request: {
					number: 5,
					html_url: `https://github.com/${REPO}/pull/5`,
					state: 'open',
					labels: [{ name: 'preview' }],
					head: { ref: 'feature-x', sha: 'abc', repo: { full_name: REPO } },
					base: { ref: 'main' },
				},
			}),
		)
		expect(previews()).toHaveLength(1)
	})
})
