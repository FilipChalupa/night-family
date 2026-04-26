/**
 * Issues webhook handler.
 *
 * Per plan §7: only issues with the `night` label create tasks. We watch:
 *   - `opened` — if labeled `night` already, import.
 *   - `labeled` — if the added label is `night` and we don't have a task yet,
 *     import.
 *   - `unlabeled` / `closed` — currently no-op (admin can re-add or cancel).
 */

import type { Logger } from 'pino'
import type { Dispatcher } from '../../tasks/dispatcher.ts'
import type { TaskStore } from '../../tasks/store.ts'

const NIGHT_LABEL = 'night'

interface IssuesEventCtx {
	repo: string
	body: Record<string, unknown>
	taskStore: TaskStore
	dispatcher: Dispatcher
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

	const triggeringAction =
		(action === 'opened' && hasNightLabel) ||
		(action === 'labeled' &&
			(ctx.body['label'] as { name?: string } | undefined)?.name === NIGHT_LABEL)

	if (!triggeringAction) {
		ctx.logger.debug(
			{ action, hasNightLabel, repo: ctx.repo, issue: issue.number },
			'issues event ignored',
		)
		return
	}

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
