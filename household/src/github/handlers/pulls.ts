/**
 * Pull request + review webhook handlers.
 *
 * Per plan §6 / §7:
 *   - PR `opened`/`synchronize` updates `pr_url` on the originating task.
 *   - PR `closed` with `merged: true` → task → `done`.
 *   - `behind_by > 0` after a base-branch push → enqueue a `rebase` task
 *     pointing at the parent implement task; dispatcher routes it to a
 *     Member with the `implement` skill (preferring the original
 *     implementer for cache warmth). The Member runs a deterministic
 *     git-only path (no LLM); conflicts fail fast.
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
			ctx.logger.info({ taskId: task.id, prUrl: pr.html_url }, 'PR registered')
			break

		case 'synchronize':
			persistPrUrl(ctx.taskStore, task, pr.html_url)
			break

		case 'edited':
		case 'labeled':
		case 'unlabeled':
			break

		case 'ready_for_review':
			ctx.taskStore.transition(task.id, ['in-progress', 'assigned'], 'in-review', {})
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

	// Stale base detection. Some webhook payloads include `behind_by`; for
	// others we'd need an Octokit follow-up call. MVP uses what's already
	// there, gracefully handling missing fields.
	if (typeof pr.behind_by === 'number' && pr.behind_by > 0) {
		enqueueRebaseTask(ctx, task, pr)
	}
}

/**
 * Enqueue a `rebase` TaskKind for the parent implement task whose PR has
 * gone stale. Idempotent: skips if any active rebase task already exists
 * for this PR (a single base-branch push fires multiple `synchronize`
 * events). The dispatcher's `previousMemberId` bias plus the implementer
 * snapshot already on the parent task means the original implementer
 * gets first dibs on running the rebase, with a warm workspace cache.
 */
function enqueueRebaseTask(ctx: PullsEventCtx, parent: TaskRecord, pr: PullRequestPayload): void {
	if (parent.kind === 'rebase') return // don't rebase the rebase task itself
	const sameUrl = ctx.taskStore.listByPrUrl(pr.html_url)
	const activeRebase = sameUrl.find(
		(t) => t.kind === 'rebase' && ACTIVE_REBASE_STATUSES.has(t.status),
	)
	if (activeRebase) {
		ctx.logger.debug(
			{ parentId: parent.id, rebaseId: activeRebase.id, behind_by: pr.behind_by },
			'rebase task already in flight for this PR — skipping',
		)
		return
	}
	const created = ctx.taskStore.create({
		kind: 'rebase',
		title: `Rebase: ${parent.title}`,
		description: `PR ${pr.html_url} is ${pr.behind_by} commit(s) behind \`${pr.base.ref}\`. Rebase the head branch onto the latest base, run any quick sanity checks the repo offers, and force-push with lease.`,
		repo: ctx.repo,
		githubIssueNumber: parent.githubIssueNumber,
		githubIssueUrl: parent.githubIssueUrl,
		metadata: {
			parent_task_id: parent.id,
			pr_url: pr.html_url,
			head_ref: pr.head.ref,
			base_ref: pr.base.ref,
			head_sha: pr.head.sha,
			behind_by: pr.behind_by,
		},
	})
	// Pin pr_url on the rebase task too, so other queries (`listByPrUrl`,
	// `findByPrUrl`) include it. The dispatcher's `prefer the previous
	// member` bias keys off `previousMemberId`; copy the parent's
	// implementer over so the rebase preferentially lands there.
	ctx.taskStore.transition(created.id, ['queued'], 'queued', { prUrl: pr.html_url })
	if (parent.assignedMemberId) {
		ctx.taskStore.stampPreviousMember(created.id, parent.assignedMemberId)
	}
	ctx.logger.info(
		{
			rebaseId: created.id,
			parentId: parent.id,
			behind_by: pr.behind_by,
			head_ref: pr.head.ref,
			base_ref: pr.base.ref,
		},
		'rebase task enqueued',
	)
	ctx.dispatcher.tryDispatchAll()
}

export async function handlePullRequestReviewEvent(ctx: PullsEventCtx): Promise<void> {
	const action = ctx.body['action']
	const pr = ctx.body['pull_request'] as PullRequestPayload | undefined
	const review = ctx.body['review'] as
		| { state: 'commented' | 'approved' | 'changes_requested'; body?: string }
		| undefined
	if (action !== 'submitted' || !pr || !review) return

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
