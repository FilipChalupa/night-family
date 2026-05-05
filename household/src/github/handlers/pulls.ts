/**
 * Pull request + review webhook handlers.
 *
 * Per plan §6 / §7:
 *   - PR `opened`/`synchronize` updates `pr_url` on the originating task.
 *   - PR `closed` with `merged: true` → task → `done`.
 *   - `behind_by > 0` after a base-branch push → send `task.rebase_suggested`.
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
import type { ConnectedMember, MemberRegistry } from '../../members/registry.ts'
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
					[
						'in-progress',
						'in-review',
						'awaiting-merge',
						'assigned',
						'estimating',
						'queued',
						'new',
					],
					'done',
				)
				ctx.logger.info({ taskId: task.id }, 'PR merged → task done')
				ctx.notifSender
					?.fire('pr.merged', { taskId: task.id, prUrl: pr.html_url, title: task.title })
					.catch(() => undefined)
			} else {
				ctx.taskStore.transition(
					task.id,
					[
						'in-progress',
						'in-review',
						'awaiting-merge',
						'assigned',
						'estimating',
						'queued',
						'new',
					],
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
		const conn = ctx.registry.findConnectionForTask(
			task.assignedSessionId,
			task.assignedMemberId,
		)
		if (conn) {
			suggestRebase(conn, task.id, pr.behind_by, ctx.logger)
		}
	}
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

function suggestRebase(
	conn: ConnectedMember,
	taskId: string,
	behindBy: number,
	logger: Logger,
): void {
	conn.send({ type: 'task.rebase_suggested', task_id: taskId, behind_by: behindBy })
	logger.info({ taskId, behindBy }, 'task.rebase_suggested sent')
}
