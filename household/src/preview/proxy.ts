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

import type { Context, Hono } from 'hono'
import type { PreviewPort, TaskStatus } from '@night/shared'
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

/** The exposed ports a preview task reported, normalised to a typed list. */
export function previewPortsOf(task: TaskRecord): PreviewPort[] {
	const raw = task.metadata?.['preview_ports']
	if (!Array.isArray(raw)) return []
	return raw.filter(
		(p): p is PreviewPort =>
			!!p && typeof p === 'object' && typeof (p as PreviewPort).url === 'string',
	)
}

/**
 * Decide what `/previews/:taskId(/:port)` should do for a task. Pure, so the
 * routing in {@link mountPreviewProxy} stays a thin shell over it. With no
 * `port`, resolves the primary (first) port; with a `port`, the matching one.
 */
export function resolvePreviewRedirect(
	task: TaskRecord | null,
	port: number | null = null,
): PreviewRedirect {
	if (!task) return { kind: 'not_found' }
	if (!ACTIVE_STATUSES.has(task.status)) return { kind: 'gone' }
	const ports = previewPortsOf(task)
	if (ports.length === 0) return { kind: 'not_ready' }
	const chosen = port === null ? ports[0]! : ports.find((p) => p.port === port)
	if (!chosen) return { kind: 'not_found' }
	return { kind: 'redirect', location: chosen.target || chosen.url }
}

export function mountPreviewProxy(app: Hono, deps: PreviewProxyDeps): void {
	const handle = (taskId: string, port: number | null) => {
		const task = deps.taskStore.get(taskId)
		return resolvePreviewRedirect(task, port)
	}
	const respond = (c: Context, result: PreviewRedirect) => {
		switch (result.kind) {
			case 'redirect':
				return c.redirect(result.location, 302)
			case 'not_found':
				return c.text('No such preview.', 404)
			case 'gone':
				return c.text('This preview has ended.', 410)
			case 'not_ready':
				return c.text('Preview is starting — try again shortly.', 503)
		}
	}
	app.get('/previews/:taskId', (c) => respond(c, handle(c.req.param('taskId'), null)))
	app.get('/previews/:taskId/:port', (c) => {
		const raw = Number.parseInt(c.req.param('port'), 10)
		const port = Number.isFinite(raw) ? raw : null
		return respond(c, handle(c.req.param('taskId'), port))
	})
}
