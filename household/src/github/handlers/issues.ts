/**
 * Issues webhook handler.
 *
 * Per plan §7: only issues with the `night` label create tasks. We watch:
 *   - `opened` — if labeled `night` already, import.
 *   - `labeled` — if the added label is `night`: import a new task, or retry
 *     the prior task if it was previously cancelled by removing the label.
 *   - `unlabeled` (the `night` label was removed) — cancel the task.
 *   - `closed` — cancel the task unless it already reached a terminal /
 *     awaiting-merge state (those are handled by the PR webhook).
 */

import type { Logger } from 'pino'
import type { MemberRegistry } from '../../members/registry.ts'
import type { Dispatcher } from '../../tasks/dispatcher.ts'
import type { TaskRecord, TaskStore } from '../../tasks/store.ts'
import type { RepoBindingStore } from '../bindings.ts'

const NIGHT_LABEL = 'night'

interface IssuesEventCtx {
	repo: string
	body: Record<string, unknown>
	taskStore: TaskStore
	dispatcher: Dispatcher
	registry: MemberRegistry
	bindings: RepoBindingStore
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
	const existing = findTasksForIssue(ctx.taskStore, ctx.repo, issue.number)
	if (existing.length > 0) {
		const failed = existing.filter((t) => t.status === 'failed')
		if (failed.length > 0) {
			for (const task of failed) retryFailedTask(ctx, task)
			ctx.dispatcher.tryDispatchAll()
			return
		}
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

	// Acknowledge the import on the issue itself with an 👀 reaction so anyone
	// looking at the issue on GitHub can see Night Family picked it up. Best
	// effort — never let a reaction failure abort the import.
	void addEyesReaction(ctx, issue.number)
}

async function addEyesReaction(ctx: IssuesEventCtx, issueNumber: number): Promise<void> {
	const pat = ctx.bindings.getPat(ctx.repo)
	if (!pat) {
		ctx.logger.debug(
			{ repo: ctx.repo, issue: issueNumber },
			'eyes reaction skipped (no PAT for repo)',
		)
		return
	}
	try {
		const res = await fetch(
			`https://api.github.com/repos/${ctx.repo}/issues/${issueNumber}/reactions`,
			{
				method: 'POST',
				headers: {
					accept: 'application/vnd.github+json',
					authorization: `Bearer ${pat}`,
					'content-type': 'application/json',
					'x-github-api-version': '2022-11-28',
				},
				body: JSON.stringify({ content: 'eyes' }),
			},
		)
		if (!res.ok && res.status !== 200) {
			const body = await res.text().catch(() => '')
			ctx.logger.warn(
				{
					repo: ctx.repo,
					issue: issueNumber,
					status: res.status,
					body: body.slice(0, 200),
				},
				'eyes reaction failed',
			)
		}
	} catch (err) {
		ctx.logger.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			'eyes reaction errored',
		)
	}
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

function findTasksForIssue(store: TaskStore, repo: string, issueNumber: number): TaskRecord[] {
	return store.list({ repo }).filter((t) => {
		const meta = t.metadata as Record<string, unknown> | null
		return meta?.['github_issue_number'] === issueNumber
	})
}

function retryFailedTask(ctx: IssuesEventCtx, task: TaskRecord): void {
	const target: TaskRecord['status'] = task.estimateSize ? 'queued' : 'new'
	const updated = ctx.taskStore.transition(task.id, ['failed'], target, {
		failureReason: null,
		retryCount: 0,
	})
	if (!updated) {
		ctx.logger.warn({ taskId: task.id, target }, 'retry transition failed for re-labeled issue')
		return
	}
	ctx.taskStore.clearAssignment(task.id)
	ctx.logger.info(
		{ taskId: task.id, target, repo: ctx.repo },
		'task retried via night label re-add',
	)
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
