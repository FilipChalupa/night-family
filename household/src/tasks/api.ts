import type { Hono } from 'hono'
import type { Logger } from 'pino'
import type { TaskKind, TaskStatus } from '@night/shared'
import type { MemberRegistry } from '../members/registry.ts'
import type { Dispatcher } from './dispatcher.ts'
import type { TaskStore } from './store.ts'
import type { AdminGuard } from '../auth/guard.ts'

const VALID_KINDS = new Set<TaskKind>(['estimate', 'implement', 'review', 'respond', 'summarize'])

export interface TasksApiDeps {
	taskStore: TaskStore
	dispatcher: Dispatcher
	registry: MemberRegistry
	logger: Logger
	guard: AdminGuard
}

export function mountTasksApi(app: Hono, deps: TasksApiDeps): void {
	app.get('/api/tasks', (c) => {
		const status = c.req.query('status')
		const repo = c.req.query('repo') ?? undefined
		const filter: { status?: TaskStatus[]; repo?: string } = {}
		if (status) {
			filter.status = status.split(',').map((s) => s.trim()) as TaskStatus[]
		}
		if (repo) filter.repo = repo
		const tasks = deps.taskStore.list(filter)
		return c.json({ tasks })
	})

	app.get('/api/tasks/:id', (c) => {
		const id = c.req.param('id')
		const task = deps.taskStore.get(id)
		if (!task) return c.json({ error: 'not_found' }, 404)
		return c.json({ task })
	})

	app.post('/api/tasks', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult

		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}

		const parsed = parseCreateBody(body)
		if ('error' in parsed) return c.json({ error: parsed.error }, 400)

		const task = deps.taskStore.create(parsed)
		deps.logger.info({ taskId: task.id, kind: task.kind }, 'task created')
		deps.dispatcher.tryDispatchAll()
		return c.json({ task }, 201)
	})

	app.patch('/api/tasks/:id', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const id = c.req.param('id')
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		const patch = parsePatchBody(body)
		if ('error' in patch) return c.json({ error: patch.error }, 400)
		const task = deps.taskStore.patch(id, patch)
		if (!task) return c.json({ error: 'not_found' }, 404)
		return c.json({ task })
	})

	app.post('/api/tasks/:id/cancel', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const id = c.req.param('id')
		const task = deps.taskStore.get(id)
		if (!task) return c.json({ error: 'not_found' }, 404)

		if (task.assignedSessionId) {
			const conn = deps.registry.get(task.assignedSessionId)
			if (conn) {
				conn.send({ type: 'task.cancel', task_id: id, reason: 'admin_cancel' })
				deps.logger.info({ taskId: id, member: conn.memberName }, 'cancel sent')
				return c.json({ ok: true, mode: 'sent_to_member' })
			}
		}

		// Not currently dispatched — just mark failed.
		deps.taskStore.transition(id, [task.status], 'failed', {
			failureReason: 'cancelled',
		})
		deps.taskStore.clearAssignment(id)
		return c.json({ ok: true, mode: 'cancelled_locally' })
	})

	app.delete('/api/tasks/:id', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const id = c.req.param('id')
		const ok = deps.taskStore.delete(id)
		if (!ok) return c.json({ error: 'not_found' }, 404)
		return c.json({ ok: true })
	})
}

function parseCreateBody(body: unknown):
	| { error: string }
	| {
			kind: TaskKind
			title: string
			description: string
			repo: string | null
			skipEstimate: boolean
			metadata?: Record<string, unknown>
	  } {
	if (!body || typeof body !== 'object') return { error: 'expected_object' }
	const b = body as Record<string, unknown>
	const kind = b['kind']
	if (typeof kind !== 'string' || !VALID_KINDS.has(kind as TaskKind)) {
		return { error: 'invalid_kind' }
	}
	const title = b['title']
	if (typeof title !== 'string' || title.length === 0 || title.length > 200) {
		return { error: 'invalid_title' }
	}
	const description = b['description']
	if (typeof description !== 'string') return { error: 'invalid_description' }
	const repo = b['repo']
	if (repo !== undefined && repo !== null && typeof repo !== 'string') {
		return { error: 'invalid_repo' }
	}
	const repoNorm = typeof repo === 'string' && repo.length > 0 ? repo : null

	// Implement tasks go through estimate by default; everything else skips it.
	const skipEstimate =
		typeof b['skip_estimate'] === 'boolean' ? b['skip_estimate'] : kind !== 'implement'

	const result: ReturnType<typeof parseCreateBody> = {
		kind: kind as TaskKind,
		title,
		description,
		repo: repoNorm,
		skipEstimate,
	}
	if (b['metadata'] && typeof b['metadata'] === 'object' && !Array.isArray(b['metadata'])) {
		;(result as { metadata?: Record<string, unknown> }).metadata = b['metadata'] as Record<
			string,
			unknown
		>
	}
	return result
}

function parsePatchBody(body: unknown):
	| { error: string }
	| {
			title?: string
			description?: string
			estimateSize?: 'S' | 'M' | 'L' | 'XL' | null
			estimateBlockers?: string[] | null
	  } {
	if (!body || typeof body !== 'object') return { error: 'expected_object' }
	const b = body as Record<string, unknown>
	const out: {
		title?: string
		description?: string
		estimateSize?: 'S' | 'M' | 'L' | 'XL' | null
		estimateBlockers?: string[] | null
	} = {}
	if (b['title'] !== undefined) {
		if (typeof b['title'] !== 'string') return { error: 'invalid_title' }
		out.title = b['title']
	}
	if (b['description'] !== undefined) {
		if (typeof b['description'] !== 'string') return { error: 'invalid_description' }
		out.description = b['description']
	}
	if (b['estimate_size'] !== undefined) {
		const s = b['estimate_size']
		if (s !== null && s !== 'S' && s !== 'M' && s !== 'L' && s !== 'XL') {
			return { error: 'invalid_estimate_size' }
		}
		out.estimateSize = s as 'S' | 'M' | 'L' | 'XL' | null
	}
	if (b['estimate_blockers'] !== undefined) {
		const blockers = b['estimate_blockers']
		if (blockers === null) {
			out.estimateBlockers = null
		} else if (Array.isArray(blockers) && blockers.every((x) => typeof x === 'string')) {
			out.estimateBlockers = blockers
		} else {
			return { error: 'invalid_estimate_blockers' }
		}
	}
	return out
}

export const VALID_TASK_KINDS = VALID_KINDS
