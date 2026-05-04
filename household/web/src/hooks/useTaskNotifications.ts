import { useEffect, useRef } from 'react'
import type { TaskRecord, TaskStatus } from '../types.ts'

/**
 * Fire desktop notifications when a task transitions into a state the user
 * cares about. Skipped:
 *   - The first non-empty render after a WS snapshot lands (would otherwise
 *     spam dozens of notifications for already-done tasks on page load).
 *   - When the page is currently visible — the dashboard itself is already
 *     showing the change and a notification is just noise.
 *   - When `Notification.permission !== 'granted'`. The user toggles permission
 *     via `<NotificationsToggle>`; this hook is a no-op until then.
 *
 * Note: this is in-tab only. For server-driven push that works with the tab
 * closed, see [registerSW.ts](../registerSW.ts) + the `push` handler in `sw.js`.
 */
export function useTaskNotifications(tasks: TaskRecord[]): void {
	const seenSnapshot = useRef(false)
	const previous = useRef<Map<string, TaskStatus>>(new Map())

	useEffect(() => {
		const current = new Map(tasks.map((t) => [t.id, t.status]))

		// Treat the first non-empty render as the baseline. Empty stays a
		// "still waiting for snapshot" state so we don't suppress real
		// transitions when the WS arrives later.
		if (!seenSnapshot.current) {
			if (tasks.length > 0) {
				previous.current = current
				seenSnapshot.current = true
			}
			return
		}

		if (
			typeof Notification === 'undefined' ||
			Notification.permission !== 'granted' ||
			(typeof document !== 'undefined' && document.visibilityState === 'visible')
		) {
			previous.current = current
			return
		}

		for (const t of tasks) {
			const before = previous.current.get(t.id)
			if (before === undefined || before === t.status) continue
			const summary = describe(t, before)
			if (!summary) continue
			try {
				const n = new Notification(summary.title, {
					body: summary.body,
					tag: t.id, // collapses duplicate notifications for the same task
					icon: '/icon-192.png',
					badge: '/icon-192.png',
				})
				n.onclick = () => {
					window.focus()
					window.location.href = `/tasks/${encodeURIComponent(t.id)}`
				}
			} catch {
				// Notification constructor can throw in some browsers when called
				// from a non-secure context or without a service worker. We're
				// best-effort here.
			}
		}

		previous.current = current
	}, [tasks])
}

/**
 * Decide whether a transition deserves a notification, and what to say.
 *
 * `in-review → in-progress` is the household's signal for "reviewer requested
 * changes" — handlePullRequestReviewEvent is the only path that performs that
 * transition (see household/src/github/handlers/pulls.ts), so it's safe to
 * treat as such on the UI side.
 */
export function describe(
	task: TaskRecord,
	previous: TaskStatus,
): { title: string; body: string } | null {
	if (task.status === 'failed') {
		return {
			title: 'Task failed',
			body: task.failureReason ? `${task.title}\n${task.failureReason}` : task.title,
		}
	}
	if (task.status === 'awaiting-merge') {
		return {
			title: 'Ready for merge',
			body: task.title,
		}
	}
	if (task.status === 'done') {
		return {
			title: 'Task done',
			body: task.title,
		}
	}
	if (previous === 'in-review' && task.status === 'in-progress') {
		return {
			title: 'Review requested changes',
			body: task.title,
		}
	}
	return null
}
