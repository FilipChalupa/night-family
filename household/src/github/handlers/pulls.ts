/**
 * Pull request + review webhook handlers.
 *
 * Per plan §6 / §7:
 *   - PR `opened`/`synchronize` updates `pr_url` (and snapshots the head/base
 *     refs into task metadata) on the originating task.
 *   - PR `closed` with `merged: true` → task → `done`.
 *   - A base-branch advance → enqueue a `rebase` task pointing at the parent
 *     implement task; dispatcher routes it to a Member with the `implement`
 *     skill (preferring the original implementer for cache warmth). The Member
 *     runs a deterministic git-only path (no LLM); it no-ops when the head is
 *     already up to date, rebases + force-pushes-with-lease when behind, and
 *     fails fast on conflict.
 *
 *     Two triggers feed this, because a `pull_request` webhook with `behind_by`
 *     only fires for a handful of actions and a plain push to `main` doesn't
 *     fire one at all:
 *       1. `behind_by > 0` on a `pull_request` payload (legacy/opportunistic).
 *       2. A `push` event to a branch that is the base of an open Night PR
 *          (see {@link handlePushEvent}) — the real-world "main moved, the PR
 *          silently fell behind" path.
 *     The periodic freshness sweep in `index.ts` is a third, time-driven
 *     trigger that reuses {@link enqueueRebaseForTask}.
 *   - PR review submitted with `state: changes_requested` → task → `queued`
 *     (preserving `assignedMemberId` so the original implementer reclaims it
 *     and reuses its warm workspace + prompt cache; falls back to any other
 *     idle member if the original is unavailable).
 *   - PR review submitted with `state: approved`, mergeable_state: `clean` → `awaiting-merge`.
 *
 * Tasks are matched by branch name (`pr/night/<task-id-prefix>-…`) or by
 * stored `pr_url` metadata. Branch name is the primary key.
 */

import type { Logger } from 'pino'
import type { Dispatcher } from '../../tasks/dispatcher.ts'
import type { MemberRegistry } from '../../members/registry.ts'
import type { NotificationSender } from '../../notifications/sender.ts'
import type { TaskRecord, TaskStore } from '../../tasks/store.ts'
import { isTrustedAuthorAssociation } from './trust.ts'

interface PullsEventCtx {
	repo: string
	body: Record<string, unknown>
	taskStore: TaskStore
	dispatcher: Dispatcher
	registry: MemberRegistry
	notifSender?: NotificationSender | undefined
	logger: Logger
}

interface PullRequestPayload {
	number: number
	html_url: string
	state: 'open' | 'closed'
	merged: boolean
	mergeable_state?: string
	behind_by?: number
	head: { ref: string; sha: string }
	base: { ref: string }
}

/**
 * Statuses a rebase task is considered "still in flight" — used to dedupe
 * webhook-driven rebase enqueues (a single base-branch push can fire
 * multiple `synchronize` events; we only want one rebase task at a time
 * per PR).
 */
const ACTIVE_REBASE_STATUSES: ReadonlySet<TaskRecord['status']> = new Set([
	'queued',
	'assigned',
	'in-progress',
])

/**
 * Task statuses that represent an open PR finished implementing and waiting on
 * humans — the only states we proactively keep rebased. Deliberately excludes
 * `queued`/`assigned`/`in-progress` implement tasks: a Member is (or soon will
 * be) actively pushing that branch from its own worktree, so a concurrent
 * rebase task would just race the lease.
 */
export const OPEN_PR_STATUSES: readonly TaskRecord['status'][] = ['in-review', 'awaiting-merge']

/**
 * Smallest interval between two rebase enqueues for the same PR. A burst of
 * commits landing on `main` fires one `push` event each; without this a 10-commit
 * merge to base would queue 10 rebase tasks back-to-back as each finishes. Long
 * enough for one rebase round-trip to land; short enough that a genuinely new
 * base advance an hour later still gets serviced.
 */
const REBASE_COOLDOWN_MS = 10 * 60_000

/**
 * Minimal dependency surface for enqueuing a rebase task — satisfied by both
 * the webhook {@link PullsEventCtx} and the periodic sweep in `index.ts`.
 */
export interface RebaseEnqueueDeps {
	taskStore: TaskStore
	dispatcher: Dispatcher
	logger: Logger
}

export async function handlePullRequestEvent(ctx: PullsEventCtx): Promise<void> {
	const action = ctx.body['action']
	const pr = ctx.body['pull_request'] as PullRequestPayload | undefined
	if (typeof action !== 'string' || !pr) return

	const task = findTaskForPr(ctx.taskStore, ctx.repo, pr)
	if (!task) {
		ctx.logger.debug(
			{ action, repo: ctx.repo, prNumber: pr.number, branch: pr.head.ref },
			'no Night task matches this PR',
		)
		return
	}

	switch (action) {
		case 'opened':
		case 'reopened':
			ctx.taskStore.patch(task.id, {})
			persistPrUrl(ctx.taskStore, task, pr.html_url)
			persistPrRefs(ctx.taskStore, task, pr)
			ctx.logger.info({ taskId: task.id, prUrl: pr.html_url }, 'PR registered')
			break

		case 'synchronize':
			persistPrUrl(ctx.taskStore, task, pr.html_url)
			persistPrRefs(ctx.taskStore, task, pr)
			break

		case 'edited':
		case 'labeled':
		case 'unlabeled':
			break

		case 'ready_for_review':
			ctx.taskStore.transition(task.id, ['in-progress', 'assigned'], 'in-review', {})
			persistPrRefs(ctx.taskStore, task, pr)
			break

		case 'closed':
			if (pr.merged) {
				ctx.taskStore.transition(
					task.id,
					['in-progress', 'in-review', 'awaiting-merge', 'assigned', 'queued'],
					'done',
				)
				ctx.logger.info({ taskId: task.id }, 'PR merged → task done')
				ctx.notifSender
					?.fire('pr.merged', { taskId: task.id, prUrl: pr.html_url, title: task.title })
					.catch(() => undefined)
			} else {
				ctx.taskStore.transition(
					task.id,
					['in-progress', 'in-review', 'awaiting-merge', 'assigned', 'queued'],
					'failed',
					{ failureReason: 'pr_closed_without_merge' },
				)
			}
			// PR done — make sure the assigned Member is freed if still busy.
			{
				const conn = ctx.registry.findConnectionForTask(
					task.assignedSessionId,
					task.assignedMemberId,
				)
				if (conn) conn.send({ type: 'task.cancel', task_id: task.id, reason: 'pr_closed' })
			}
			break
	}

	// Stale base detection (trigger #1). Some `pull_request` payloads carry
	// `behind_by`; most don't, and a plain push to the base branch fires no
	// `pull_request` event at all — that gap is covered by `handlePushEvent`
	// (trigger #2) and the periodic sweep (trigger #3).
	if (typeof pr.behind_by === 'number' && pr.behind_by > 0) {
		enqueueRebaseTask(ctx, task, {
			prUrl: pr.html_url,
			headRef: pr.head.ref,
			baseRef: pr.base.ref,
			headSha: pr.head.sha,
			behindBy: pr.behind_by,
		})
	}
}

interface RebaseEnqueueOpts {
	prUrl: string
	headRef: string
	baseRef: string
	headSha?: string
	/** Known commits-behind, when a webhook reported it. Informational only. */
	behindBy?: number
	/** Why this rebase was enqueued — surfaced in logs (`push` / `sweep` / `behind_by`). */
	reason?: string
}

/**
 * Enqueue a `rebase` TaskKind for the parent implement task whose PR has
 * gone stale. Skips if any active rebase task already exists for this PR (a
 * single base-branch push fires multiple `synchronize` events). A second layer
 * of idempotence lives Member-side: the deterministic rebase path no-ops
 * without a force-push when the head is already up to date, so over-enqueuing
 * here is cheap and safe. The speculative triggers (push / sweep) add a
 * per-PR cooldown on top — see {@link enqueueRebaseForTask}.
 *
 * The dispatcher's `previousMemberId` bias plus the implementer snapshot
 * means the original implementer gets first dibs, with a warm workspace cache.
 */
function enqueueRebaseTask(
	deps: RebaseEnqueueDeps,
	parent: TaskRecord,
	opts: RebaseEnqueueOpts,
): void {
	if (parent.kind === 'rebase') return // don't rebase the rebase task itself
	const repo = parent.repo
	if (!repo) return // can't rebase a repo-less task

	const sameUrl = deps.taskStore.listByPrUrl(opts.prUrl)
	const activeRebase = sameUrl.find(
		(t) => t.kind === 'rebase' && ACTIVE_REBASE_STATUSES.has(t.status),
	)
	if (activeRebase) {
		deps.logger.debug(
			{ parentId: parent.id, rebaseId: activeRebase.id, reason: opts.reason ?? null },
			'rebase task already in flight for this PR — skipping',
		)
		return
	}

	const behindClause =
		typeof opts.behindBy === 'number'
			? `${opts.behindBy} commit(s) behind`
			: 'potentially behind'
	const created = deps.taskStore.create({
		kind: 'rebase',
		title: `Rebase: ${parent.title}`,
		description: `PR ${opts.prUrl} is ${behindClause} \`${opts.baseRef}\`. Rebase the head branch onto the latest base, run any quick sanity checks the repo offers, and force-push with lease.`,
		repo,
		githubIssueNumber: parent.githubIssueNumber,
		githubIssueUrl: parent.githubIssueUrl,
		metadata: {
			parent_task_id: parent.id,
			pr_url: opts.prUrl,
			head_ref: opts.headRef,
			base_ref: opts.baseRef,
			...(opts.headSha ? { head_sha: opts.headSha } : {}),
			...(typeof opts.behindBy === 'number' ? { behind_by: opts.behindBy } : {}),
		},
	})
	// Pin pr_url on the rebase task too, so other queries (`listByPrUrl`,
	// `findByPrUrl`) include it. The dispatcher's `prefer the previous
	// member` bias keys off `previousMemberId`; copy the parent's
	// implementer over so the rebase preferentially lands there.
	deps.taskStore.transition(created.id, ['queued'], 'queued', { prUrl: opts.prUrl })
	// Prefer the original implementer for cache warmth. After a
	// `changes_requested` review clears the active assignment, the
	// implementer is stamped into `previousMemberId` instead; fall back to it.
	const preferredMemberId = parent.assignedMemberId ?? parent.previousMemberId
	if (preferredMemberId) {
		deps.taskStore.stampPreviousMember(created.id, preferredMemberId)
	}
	deps.logger.info(
		{
			rebaseId: created.id,
			parentId: parent.id,
			reason: opts.reason ?? 'behind_by',
			head_ref: opts.headRef,
			base_ref: opts.baseRef,
		},
		'rebase task enqueued',
	)
	deps.dispatcher.tryDispatchAll()
}

/**
 * Enqueue a rebase for an open PR task using the head/base refs snapshotted
 * into its metadata when the PR was registered. Shared by {@link handlePushEvent}
 * and the periodic freshness sweep — the speculative triggers that don't know
 * whether the PR is actually behind. Applies a per-PR cooldown on top of the
 * core's active-dedup so a burst of base commits doesn't queue a rebase each.
 * No-ops (returns `false`) when the task isn't an open PR with usable refs or
 * is within the cooldown window.
 */
export function enqueueRebaseForTask(
	deps: RebaseEnqueueDeps,
	task: TaskRecord,
	reason: string,
	now: number = Date.now(),
): boolean {
	if (task.kind === 'rebase') return false
	if (!task.prUrl) return false
	const meta = task.metadata ?? {}
	const headRef = typeof meta['head_ref'] === 'string' ? meta['head_ref'] : null
	const baseRef = typeof meta['base_ref'] === 'string' ? meta['base_ref'] : null
	if (!headRef || !baseRef) {
		deps.logger.debug(
			{ taskId: task.id, reason },
			'cannot enqueue rebase — task is missing head_ref/base_ref metadata',
		)
		return false
	}
	const recentRebase = deps.taskStore
		.listByPrUrl(task.prUrl)
		.find(
			(t) =>
				t.kind === 'rebase' && now - new Date(t.createdAt).getTime() < REBASE_COOLDOWN_MS,
		)
	if (recentRebase) {
		deps.logger.debug(
			{ taskId: task.id, rebaseId: recentRebase.id, reason },
			'rebase for this PR enqueued within cooldown — skipping',
		)
		return false
	}
	enqueueRebaseTask(deps, task, { prUrl: task.prUrl, headRef, baseRef, reason })
	return true
}

/**
 * Periodic freshness sweep — trigger #3, time-driven. Walks every open Night
 * PR whose task row hasn't been touched in `staleAfterMs` and enqueues an
 * idempotent rebase. Catches PRs whose base advanced while the Household was
 * down, or via a push event we never received (e.g. a fork-side base merge).
 *
 * Returns the count of rebases actually enqueued — the active-dedup and
 * cooldown guards in {@link enqueueRebaseTask} (plus the Member-side no-op for
 * already-current heads) mean most sweeps over a quiet fleet enqueue nothing.
 */
export function sweepStalePrsForRebase(
	deps: RebaseEnqueueDeps,
	staleAfterMs: number,
	now: number = Date.now(),
): number {
	const open = deps.taskStore.list({ status: [...OPEN_PR_STATUSES] })
	let enqueued = 0
	for (const task of open) {
		if (task.kind === 'rebase') continue
		if (now - new Date(task.updatedAt).getTime() < staleAfterMs) continue
		if (enqueueRebaseForTask(deps, task, 'sweep')) enqueued++
	}
	return enqueued
}

interface PushPayload {
	ref?: string
	deleted?: boolean
}

/**
 * `push` webhook handler — trigger #2 for rebases. A push to a branch fires
 * no `pull_request` event for the PRs that target it, so without this an open
 * PR silently falls behind `main` and never gets refreshed.
 *
 * For a push to branch B in this repo, find every open Night PR whose base is
 * B and enqueue an (idempotent, cooldown-throttled) rebase. The Member decides
 * whether a rebase is actually needed and no-ops if the head is already current.
 */
export async function handlePushEvent(ctx: PullsEventCtx): Promise<void> {
	const push = ctx.body as PushPayload
	const ref = push.ref
	if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) return // tags / non-branch
	if (push.deleted) return // branch deletion isn't a base advance
	const branch = ref.slice('refs/heads/'.length)

	const openPrs = ctx.taskStore
		.list({ repo: ctx.repo, status: [...OPEN_PR_STATUSES] })
		.filter((t) => t.kind !== 'rebase' && (t.metadata?.['base_ref'] ?? null) === branch)

	if (openPrs.length === 0) return
	ctx.logger.info(
		{ repo: ctx.repo, branch, candidates: openPrs.length },
		'base branch advanced — checking open PRs for rebase',
	)
	for (const task of openPrs) {
		enqueueRebaseForTask(ctx, task, 'push')
	}
}

export async function handlePullRequestReviewEvent(ctx: PullsEventCtx): Promise<void> {
	const action = ctx.body['action']
	const pr = ctx.body['pull_request'] as PullRequestPayload | undefined
	const review = ctx.body['review'] as
		| {
				state: 'commented' | 'approved' | 'changes_requested'
				body?: string
				author_association?: string
				user?: { login?: string }
		  }
		| undefined
	if (action !== 'submitted' || !pr || !review) return

	// Public-repo guard: only repo-affiliated reviewers can drive
	// automation. A drive-by review on a public repo would otherwise let
	// any GitHub user re-queue the task (`changes_requested`) or push it
	// into `awaiting-merge` (`approved`) without maintainer approval.
	if (!isTrustedAuthorAssociation(review.author_association)) {
		ctx.logger.info(
			{
				repo: ctx.repo,
				prNumber: pr.number,
				reviewer: review.user?.login ?? null,
				association: review.author_association ?? null,
				state: review.state,
			},
			'pull_request_review ignored — reviewer not in trust set',
		)
		return
	}

	const task = findTaskForPr(ctx.taskStore, ctx.repo, pr)
	if (!task) return

	if (review.state === 'changes_requested') {
		// Send back to the queue (not `in-progress`) so the dispatcher picks it
		// up. Snapshot the implementer into `previousMemberId` first — that's
		// the dispatcher's "first dibs" hint — then clear the active
		// assignment so `assignedMemberId` only ever means "currently owned".
		const stamped = ctx.taskStore.stampPreviousMember(task.id, task.assignedMemberId)
		const updated = ctx.taskStore.transition(
			task.id,
			['in-review', 'awaiting-merge'],
			'queued',
			{ failureReason: null },
		)
		if (updated) {
			ctx.taskStore.clearAssignment(task.id)
			ctx.logger.info(
				{ taskId: task.id, preferredMemberId: stamped?.previousMemberId ?? null },
				'review requested changes → queued',
			)
			ctx.dispatcher.tryDispatchAll()
		}
	} else if (review.state === 'approved' && pr.mergeable_state === 'clean') {
		ctx.taskStore.transition(task.id, ['in-review'], 'awaiting-merge')
		ctx.logger.info({ taskId: task.id }, 'review approved + clean → awaiting-merge')
	}
}

function findTaskForPr(store: TaskStore, repo: string, pr: PullRequestPayload): TaskRecord | null {
	// Primary: branch convention `pr/night/<task-id-prefix>-…`
	const m = pr.head.ref.match(/^pr\/night\/([0-9a-f]+)/i)
	if (m && m[1]) {
		const candidate = store.findByIdPrefix(repo, m[1])
		if (candidate) return candidate
	}
	// Fallback: prUrl already recorded on the task.
	return store.findByPrUrl(pr.html_url)
}

function persistPrUrl(store: TaskStore, task: TaskRecord, prUrl: string): void {
	if (task.prUrl === prUrl) return
	// `patch` doesn't support prUrl; do a lightweight transition over the
	// current status to keep updatedAt fresh and store it.
	store.transition(task.id, [task.status], task.status, { prUrl })
}

/**
 * Snapshot the PR's head/base refs into the task metadata so the push handler
 * and the freshness sweep can enqueue a rebase later without re-deriving the
 * branch name. Skips the write when both refs already match (avoids a metadata
 * churn + `task.updated` re-emit on every `synchronize`).
 */
function persistPrRefs(store: TaskStore, task: TaskRecord, pr: PullRequestPayload): void {
	const meta = task.metadata ?? {}
	if (meta['head_ref'] === pr.head.ref && meta['base_ref'] === pr.base.ref) return
	store.mergeMetadata(task.id, { head_ref: pr.head.ref, base_ref: pr.base.ref })
}
