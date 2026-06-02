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
	/**
	 * Task ids for which we've already fired the in-review "waiting on human"
	 * push, so a flurry of `republish` ticks doesn't re-notify. Cleared when a
	 * task leaves `in-review` so a later review round can notify again. In
	 * memory (not persisted like `lastNotifiedStatus`) on purpose: this edge is
	 * triggered by the last review job finishing, which is event-driven and
	 * doesn't recur after a restart — there's no later `task.updated` to
	 * re-fire on for an already-waiting task.
	 */
	private readonly notifiedWaiting = new Set<string>()

	constructor(private readonly persistence: TaskPushPersistence) {}

	/**
	 * Record `task` and return a push payload if the new status crosses a
	 * watch threshold; otherwise null. Always advances `lastNotifiedStatus`
	 * so the next observation sees the current row as the prior state, even
	 * for transitions we don't notify on.
	 */
	observe(task: TaskRecord): PushPayload | null {
		// "Waiting on human" while a task stays `in-review` is an edge with NO
		// status change — the last review job finished, so the ball moves to a
		// human (approve / push fixups / merge). The status-diff below would
		// never catch it, so detect it here. (`awaiting-merge` is the other
		// waiting state and is covered by describe()'s "Ready for merge".)
		if (task.status !== 'in-review') {
			this.notifiedWaiting.delete(task.id)
		} else if (
			task.lastNotifiedStatus !== null && // not a baseline/rehydrated row
			isWaitingOnHuman(task) &&
			!this.notifiedWaiting.has(task.id)
		) {
			this.notifiedWaiting.add(task.id)
			return {
				title: 'Ready for your review',
				body: task.title,
				taskId: task.id,
				tag: `task:${task.id}`,
			}
		}

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

/**
 * In-review tasks waiting on a human: every review job has finished (none
 * pending or in progress, at least one completed/failed). Mirrors the web
 * `isWaitingOnHuman` for the in-review case; the `awaiting-merge` case is
 * handled by the status-change path.
 */
function isWaitingOnHuman(task: TaskRecord): boolean {
	const jobs = task.reviewJobs
	if (!jobs) return false
	if (jobs.pending > 0 || jobs.inProgress > 0) return false
	return jobs.completed > 0 || jobs.failed > 0
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
