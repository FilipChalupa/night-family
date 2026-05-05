/**
 * Issues + issue-comment webhook handler. Plan §7: only issues with the
 * `night` label create tasks. We watch:
 *   - `issues.opened` — if labeled `night` already, queue a triage task.
 *   - `issues.labeled` — if the added label is `night`: queue a triage
 *     task (or retry the prior one if previously cancelled by removing
 *     the label).
 *   - `issues.unlabeled` (the `night` label was removed) — cancel.
 *   - `issues.closed` — cancel non-terminal tasks.
 *   - `issue_comment.created` — re-trigger triage on every human reply,
 *     so the agent can pick up the new context. Bot-authored comments
 *     are filtered out via the Night Family attribution marker
 *     (`<!-- night-family:... -->`) that the post_* tools embed.
 *
 * Brakes (so a chatty human or a runaway loop can't spam the queue):
 *   - **Idempotence** — never queue a second triage for an issue while
 *     one is already pending / in-progress / assigned.
 *   - **Per-issue daily cap** — at most 5 triage tasks for a single
 *     issue in any rolling 24 h window.
 *   - **Per-issue lifetime cap** — at most 20 triage tasks ever for a
 *     single issue.
 */

import { findAttributionMarker } from '@night/shared'
import type { Logger } from 'pino'
import type { MemberRegistry } from '../../members/registry.ts'
import type { Dispatcher } from '../../tasks/dispatcher.ts'
import type { TaskRecord, TaskStore } from '../../tasks/store.ts'

const NIGHT_LABEL = 'night'
const TRIAGE_DAILY_CAP = 5
const TRIAGE_LIFETIME_CAP = 20
const ACTIVE_STATUSES = new Set<TaskRecord['status']>([
	'new',
	'queued',
	'estimating',
	'assigned',
	'in-progress',
])

interface IssuesEventCtx {
	repo: string
	body: Record<string, unknown>
	taskStore: TaskStore
	dispatcher: Dispatcher
	registry: MemberRegistry
	logger: Logger
}

export async function handleIssuesEvent(ctx: IssuesEventCtx): Promise<void> {
	const action = ctx.body['action']
	if (typeof action !== 'string') return

	const issue = ctx.body['issue'] as
		| {
				number: number
				title: string
				body: string | null
				labels: Array<{ name: string }>
				html_url: string
		  }
		| undefined
	if (!issue) return

	const hasNightLabel = (issue.labels ?? []).some((l) => l?.name === NIGHT_LABEL)

	if (
		(action === 'opened' && hasNightLabel) ||
		(action === 'labeled' &&
			(ctx.body['label'] as { name?: string } | undefined)?.name === NIGHT_LABEL)
	) {
		await maybeQueueTriage(ctx, issue, action === 'opened' ? 'issue_opened' : 'label_added')
		return
	}

	if (
		action === 'unlabeled' &&
		(ctx.body['label'] as { name?: string } | undefined)?.name === NIGHT_LABEL
	) {
		cancelForIssue(ctx, issue.number, 'label_removed', new Set())
		return
	}

	if (action === 'closed') {
		// PR webhook owns the merge → done transition; don't fight it.
		cancelForIssue(ctx, issue.number, 'issue_closed', new Set(['done', 'awaiting-merge']))
		return
	}

	ctx.logger.debug(
		{ action, hasNightLabel, repo: ctx.repo, issue: issue.number },
		'issues event ignored',
	)
}

/**
 * Handle `issue_comment` webhook events. Re-triggers triage on every
 * human comment so the agent can read the latest reply and either ask
 * follow-up questions or post a plan now that things are clearer.
 */
export async function handleIssueCommentEvent(ctx: IssuesEventCtx): Promise<void> {
	const action = ctx.body['action']
	if (action !== 'created') return // ignore edited / deleted

	const issue = ctx.body['issue'] as
		| {
				number: number
				title: string
				body: string | null
				labels: Array<{ name: string }>
				html_url: string
				state?: string
		  }
		| undefined
	if (!issue) return
	if (issue.state === 'closed') return

	const hasNightLabel = (issue.labels ?? []).some((l) => l?.name === NIGHT_LABEL)
	if (!hasNightLabel) return

	const comment = ctx.body['comment'] as { body?: string } | undefined
	const commentBody = typeof comment?.body === 'string' ? comment.body : ''
	if (findAttributionMarker(commentBody) !== null) {
		// Our own bot-authored comment — never trigger a triage cycle on it.
		ctx.logger.debug(
			{ repo: ctx.repo, issue: issue.number },
			'issue_comment ignored (Night Family marker present)',
		)
		return
	}

	await maybeQueueTriage(ctx, issue, 'issue_comment')
}

async function maybeQueueTriage(
	ctx: IssuesEventCtx,
	issue: { number: number; title: string; body: string | null; html_url: string },
	source: string,
): Promise<void> {
	const existing = ctx.taskStore.findByIssueNumber(ctx.repo, issue.number)

	// Retry path: if the only thing on file is a previously-cancelled
	// triage (label was removed and re-added), revive it.
	const activeNow = existing.find((t) => t.kind === 'triage' && ACTIVE_STATUSES.has(t.status))
	if (activeNow) {
		ctx.logger.info(
			{ repo: ctx.repo, issue: issue.number, source, taskId: activeNow.id },
			'triage already in flight — skipped (idempotent)',
		)
		return
	}

	const triageHistory = existing.filter((t) => t.kind === 'triage')
	if (triageHistory.length >= TRIAGE_LIFETIME_CAP) {
		ctx.logger.warn(
			{ repo: ctx.repo, issue: issue.number, count: triageHistory.length },
			`triage lifetime cap (${TRIAGE_LIFETIME_CAP}) reached for issue — refusing to queue more`,
		)
		return
	}
	const dayAgo = Date.now() - 24 * 60 * 60 * 1000
	const recent = triageHistory.filter((t) => Date.parse(t.createdAt) >= dayAgo)
	if (recent.length >= TRIAGE_DAILY_CAP) {
		ctx.logger.warn(
			{ repo: ctx.repo, issue: issue.number, count: recent.length },
			`triage daily cap (${TRIAGE_DAILY_CAP}) reached for issue — refusing to queue more`,
		)
		return
	}

	// If a previous triage task for this issue is in `failed` state, retry it
	// in place rather than creating a new row. Keeps the task list tidy.
	const failedTriage = triageHistory.find((t) => t.status === 'failed')
	if (failedTriage) {
		retryFailedTask(ctx, failedTriage)
		ctx.dispatcher.tryDispatchAll()
		return
	}

	const task = ctx.taskStore.create({
		kind: 'triage',
		title: issue.title.slice(0, 200),
		description: buildDescription(issue),
		repo: ctx.repo,
		githubIssueNumber: issue.number,
		githubIssueUrl: issue.html_url,
		// Triage doesn't need a separate estimate precursor — the agent's
		// plan output includes its own size estimate.
		skipEstimate: true,
	})
	ctx.logger.info(
		{ taskId: task.id, repo: ctx.repo, issue: issue.number, source },
		'triage task queued',
	)
	ctx.dispatcher.tryDispatchAll()
}

function cancelForIssue(
	ctx: IssuesEventCtx,
	issueNumber: number,
	reason: string,
	skipStatuses: Set<TaskRecord['status']>,
): void {
	const tasks = ctx.taskStore.findByIssueNumber(ctx.repo, issueNumber)
	for (const task of tasks) {
		if (skipStatuses.has(task.status) || task.status === 'failed') {
			ctx.logger.debug(
				{ taskId: task.id, status: task.status, reason },
				'cancel skipped (terminal or skipped status)',
			)
			continue
		}

		const conn = ctx.registry.findConnectionForTask(
			task.assignedSessionId,
			task.assignedMemberId,
		)
		if (conn) {
			conn.send({ type: 'task.cancel', task_id: task.id, reason })
			ctx.logger.info(
				{ taskId: task.id, member: conn.memberName, reason },
				'cancel sent to member from issues webhook',
			)
			continue
		}

		ctx.taskStore.transition(task.id, [task.status], 'failed', { failureReason: reason })
		ctx.taskStore.clearAssignment(task.id)
		ctx.logger.info({ taskId: task.id, reason }, 'cancelled locally from issues webhook')
	}
}

function retryFailedTask(ctx: IssuesEventCtx, task: TaskRecord): void {
	const updated = ctx.taskStore.transition(task.id, ['failed'], 'queued', {
		failureReason: null,
		retryCount: 0,
	})
	if (!updated) {
		ctx.logger.warn({ taskId: task.id }, 'retry transition failed')
		return
	}
	ctx.taskStore.clearAssignment(task.id)
	ctx.logger.info({ taskId: task.id, repo: ctx.repo }, 'task retried via webhook')
}

function buildDescription(issue: {
	body: string | null
	html_url: string
	number: number
}): string {
	const lines: string[] = []
	lines.push(`Imported from ${issue.html_url}`)
	lines.push('')
	lines.push((issue.body ?? '').trim())
	return lines.join('\n').trim()
}
