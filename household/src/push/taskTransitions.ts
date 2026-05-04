/**
 * Transition detector for `task.updated` events. The store fires `task.updated`
 * not just on real status changes but also on `republish` (review-job summary
 * refresh) — without diffing against the previous status we'd push duplicate
 * notifications on every job tick. This keeps a small in-memory map of last
 * seen statuses per task and only emits a push payload on a *real* transition.
 *
 * In-memory state is fine: Web Push is best-effort by nature, and a process
 * restart simply means the very next status change after restart goes
 * unannounced. Better than persisting a parallel "last notified" table.
 */

import type { TaskStatus } from '@night/shared'
import type { TaskRecord } from '../tasks/store.ts'
import type { PushPayload } from './sender.ts'

export class TaskPushTransitionTracker {
	private readonly previous = new Map<string, TaskStatus>()

	/**
	 * Record `task` and return a push payload if the new status crosses a
	 * watch threshold; otherwise null. Always updates the cached prior status
	 * so that, say, two consecutive `failed` events don't both notify.
	 */
	observe(task: TaskRecord): PushPayload | null {
		const before = this.previous.get(task.id) ?? null
		this.previous.set(task.id, task.status)

		// First time we see a task, treat as a baseline — we don't notify on
		// snapshot-rehydrated state at process start.
		if (before === null) return null
		if (before === task.status) return null

		return describe(task, before)
	}

	/** Drop a task from the tracker (e.g. after `task.deleted`). */
	forget(taskId: string): void {
		this.previous.delete(taskId)
	}
}

function describe(task: TaskRecord, before: TaskStatus): PushPayload | null {
	if (task.status === 'failed') {
		return {
			title: 'Task failed',
			body: task.failureReason
				? truncate(`${task.title}: ${task.failureReason}`, 200)
				: task.title,
			taskId: task.id,
			tag: `task:${task.id}`,
		}
	}
	if (task.status === 'awaiting-merge') {
		return {
			title: 'Ready for merge',
			body: task.title,
			taskId: task.id,
			tag: `task:${task.id}`,
		}
	}
	if (task.status === 'done') {
		return {
			title: 'Task done',
			body: task.title,
			taskId: task.id,
			tag: `task:${task.id}`,
		}
	}
	if (before === 'in-review' && task.status === 'in-progress') {
		return {
			title: 'Review requested changes',
			body: task.title,
			taskId: task.id,
			tag: `task:${task.id}`,
		}
	}
	return null
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return s.slice(0, max - 1) + '…'
}
