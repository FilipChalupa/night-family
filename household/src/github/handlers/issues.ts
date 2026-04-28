/**
 * Issues webhook handler.
 *
 * Per plan §7: only issues with the `night` label create tasks. We watch:
 *   - `opened` — if labeled `night` already, import.
 *   - `labeled` — if the added label is `night` and we don't have a task yet,
 *     import.
 *   - `unlabeled` (the `night` label was removed) — cancel the task.
 *   - `closed` — cancel the task unless it already reached a terminal /
 *     awaiting-merge state (those are handled by the PR webhook).
 */

import type { Logger } from 'pino'
import type { MemberRegistry } from '../../members/registry.ts'
import type { Dispatcher } from '../../tasks/dispatcher.ts'
import type { TaskRecord, TaskStore } from '../../tasks/store.ts'

const NIGHT_LABEL = 'night'

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
		await importIssue(ctx, issue)
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

async function importIssue(
	ctx: IssuesEventCtx,
	issue: { number: number; title: string; body: string | null; html_url: string },
): Promise<void> {
	if (existingTask(ctx.taskStore, ctx.repo, issue.number)) {
		ctx.logger.info(
			{ repo: ctx.repo, issue: issue.number },
			'task already exists for this issue',
		)
		return
	}

	const task = ctx.taskStore.create({
		kind: 'implement',
		title: issue.title.slice(0, 200),
		description: buildDescription(issue),
		repo: ctx.repo,
		metadata: {
			github_issue_number: issue.number,
			github_issue_url: issue.html_url,
		},
	})
	ctx.logger.info(
		{ taskId: task.id, repo: ctx.repo, issue: issue.number },
		'imported issue as task',
	)
	ctx.dispatcher.tryDispatchAll()
}

/**
 * Cancel the task that came from this issue, if any. Mirrors POST
 * /api/tasks/:id/cancel: in-flight Members get a `task.cancel` message,
 * everything else is marked failed locally. Tasks whose status is in
 * `skipStatuses` are left alone (e.g. already done/awaiting-merge).
 */
function cancelForIssue(
	ctx: IssuesEventCtx,
	issueNumber: number,
	reason: string,
	skipStatuses: Set<TaskRecord['status']>,
): void {
	const tasks = ctx.taskStore.list({ repo: ctx.repo }).filter((t) => {
		const meta = t.metadata as Record<string, unknown> | null
		return meta?.['github_issue_number'] === issueNumber
	})
	for (const task of tasks) {
		if (skipStatuses.has(task.status) || task.status === 'failed') {
			ctx.logger.debug(
				{ taskId: task.id, status: task.status, reason },
				'cancel skipped (terminal or skipped status)',
			)
			continue
		}

		if (task.assignedSessionId) {
			const conn = ctx.registry.get(task.assignedSessionId)
			if (conn) {
				conn.send({ type: 'task.cancel', task_id: task.id, reason })
				ctx.logger.info(
					{ taskId: task.id, member: conn.memberName, reason },
					'cancel sent to member from issues webhook',
				)
				continue
			}
		}

		ctx.taskStore.transition(task.id, [task.status], 'failed', { failureReason: reason })
		ctx.taskStore.clearAssignment(task.id)
		ctx.logger.info({ taskId: task.id, reason }, 'cancelled locally from issues webhook')
	}
}

function existingTask(store: TaskStore, repo: string, issueNumber: number): boolean {
	const matches = store.list({ repo }).filter((t) => {
		const meta = t.metadata as Record<string, unknown> | null
		return meta?.['github_issue_number'] === issueNumber
	})
	return matches.length > 0
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
