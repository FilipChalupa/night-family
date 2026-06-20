/**
 * Preview entry point — first slice of the "Household reverse proxy" direction.
 *
 * A Member running a `preview` task reports both the live server URL and a
 * stable Household-domain link (`<household>/previews/<task>`) when it publishes
 * in `household` mode. This route makes that link resolve: it 302-redirects to
 * the live server recorded on the task (`metadata.preview_target`).
 *
 * Deliberately a redirect, not a true proxy — the browser then talks to the dev
 * server directly, so HMR/WebSocket upgrades and streaming Just Work, and the
 * Household never fetches Member-supplied URLs server-side (no SSRF surface).
 * The cost: the target must be reachable from the viewer's browser. Making it
 * reachable from anywhere (proxying over the Member WS, for NAT'd Members) is
 * the next step; the URL scheme here is forward-compatible with that.
 *
 * Intentionally unauthenticated so a preview link is shareable. It only ever
 * resolves to the target a connected Member reported for an *active* preview
 * task — not an open redirect to arbitrary input.
 */

import type { Hono } from 'hono'
import type { TaskStatus } from '@night/shared'
import type { TaskRecord, TaskStore } from '../tasks/store.ts'

export interface PreviewProxyDeps {
	taskStore: TaskStore
}

/** Statuses where a preview can still be live (matches the UI's active set). */
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
])

export type PreviewRedirect =
	| { kind: 'redirect'; location: string }
	| { kind: 'not_found' }
	| { kind: 'gone' }
	| { kind: 'not_ready' }

/**
 * Decide what `/previews/:taskId` should do for a given task. Pure, so the
 * routing in {@link mountPreviewProxy} stays a thin shell over it.
 */
export function resolvePreviewRedirect(task: TaskRecord | null): PreviewRedirect {
	if (!task) return { kind: 'not_found' }
	if (!ACTIVE_STATUSES.has(task.status)) return { kind: 'gone' }
	const meta = task.metadata ?? {}
	const target =
		(typeof meta['preview_target'] === 'string' && meta['preview_target']) ||
		(typeof meta['preview_url'] === 'string' && meta['preview_url']) ||
		null
	if (!target) return { kind: 'not_ready' }
	return { kind: 'redirect', location: target }
}

export function mountPreviewProxy(app: Hono, deps: PreviewProxyDeps): void {
	app.get('/previews/:taskId', (c) => {
		const task = deps.taskStore.get(c.req.param('taskId'))
		const result = resolvePreviewRedirect(task)
		switch (result.kind) {
			case 'redirect':
				return c.redirect(result.location, 302)
			case 'not_found':
				return c.text('No such task.', 404)
			case 'gone':
				return c.text('This preview has ended.', 410)
			case 'not_ready':
				return c.text('Preview is starting — try again shortly.', 503)
		}
	})
}
