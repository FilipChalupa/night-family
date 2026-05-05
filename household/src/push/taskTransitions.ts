/**
 * Transition detector for `task.updated` events. The store fires `task.updated`
 * not just on real status changes but also on `republish` (review-job summary
 * refresh) — without diffing against the previous status we'd push duplicate
 * notifications on every job tick.
 *
 * Persistence: the previous status is stored on the task row itself
 * (`last_notified_status`). That makes the tracker idempotent across Household
 * restarts — the very next status change after restart still emits exactly
 * once — and avoids double-fires if multiple Household instances ever process
 * the same event stream.
 */

import type { TaskStatus } from '@night/shared'
import type { TaskRecord } from '../tasks/store.ts'
import type { PushPayload } from './sender.ts'

export interface TaskPushPersistence {
	setLastNotifiedStatus(taskId: string, status: TaskStatus): void
}

export class TaskPushTransitionTracker {
	constructor(private readonly persistence: TaskPushPersistence) {}

	/**
	 * Record `task` and return a push payload if the new status crosses a
	 * watch threshold; otherwise null. Always advances `lastNotifiedStatus`
	 * so the next observation sees the current row as the prior state, even
	 * for transitions we don't notify on.
	 */
	observe(task: TaskRecord): PushPayload | null {
		const before = task.lastNotifiedStatus
		if (before === task.status) return null

		// First time we see a task post-creation, treat as a baseline — we
		// don't notify on snapshot-rehydrated state at process start. Same
		// applies after a fresh insert where `lastNotifiedStatus` is null.
		if (before === null) {
			this.persistence.setLastNotifiedStatus(task.id, task.status)
			return null
		}

		const payload = describe(task, before)
		this.persistence.setLastNotifiedStatus(task.id, task.status)
		return payload
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
	if (before === 'in-review' && task.status === 'queued') {
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
