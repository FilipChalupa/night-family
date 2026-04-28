import type { Hono } from 'hono'
import type { AdminGuard } from '../auth/guard.ts'
import type {
	NotificationStore,
	NotificationEventName,
	ChannelKind,
	ChannelRecord,
} from './store.ts'
import type { NotificationSender } from './sender.ts'

const ALL_EVENTS: NotificationEventName[] = [
	'task.failed',
	'pr.merged',
	'quota_exceeded',
	'summarize.result',
	'member.disconnected',
	'token.revoked',
]

export interface NotificationsApiDeps {
	store: NotificationStore
	sender: NotificationSender
	guard: AdminGuard
}

export function mountNotificationsApi(app: Hono, deps: NotificationsApiDeps): void {
	app.get('/api/notifications/channels', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const channels = deps.store.list().map(toWire)
		return c.json({ channels })
	})

	app.get('/api/notifications/channels/:id', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const ch = deps.store.get(c.req.param('id'))
		if (!ch) return c.json({ error: 'not_found' }, 404)
		return c.json(toWire(ch))
	})

	app.post('/api/notifications/channels', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult

		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		const err = validateChannelBody(body)
		if (err) return c.json({ error: err }, 400)

		const b = body as {
			name: string
			kind: ChannelKind
			config: Record<string, unknown>
			subscribedEvents: NotificationEventName[]
		}
		const ch = deps.store.create({
			name: b.name,
			kind: b.kind,
			config: b.config as never,
			subscribedEvents: b.subscribedEvents,
		})
		return c.json(toWire(ch), 201)
	})

	app.patch('/api/notifications/channels/:id', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult

		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		if (!body || typeof body !== 'object') return c.json({ error: 'expected_object' }, 400)
		const b = body as Record<string, unknown>
		const updated = deps.store.update(c.req.param('id'), {
			...(typeof b['name'] === 'string' ? { name: b['name'] } : {}),
			...(b['config'] ? { config: b['config'] as never } : {}),
			...(Array.isArray(b['subscribedEvents'])
				? { subscribedEvents: b['subscribedEvents'] as NotificationEventName[] }
				: {}),
		})
		if (!updated) return c.json({ error: 'not_found' }, 404)
		return c.json(toWire(updated))
	})

	app.post('/api/notifications/channels/test', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult

		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		if (!body || typeof body !== 'object') return c.json({ error: 'expected_object' }, 400)
		const b = body as { kind?: unknown; config?: unknown }
		if (b.kind !== 'webhook' && b.kind !== 'smtp') return c.json({ error: 'invalid_kind' }, 400)
		if (!b.config || typeof b.config !== 'object')
			return c.json({ error: 'config_required' }, 400)
		try {
			await deps.sender.sendTest(b.kind, b.config as never)
			return c.json({ ok: true })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return c.json({ error: message }, 502)
		}
	})

	app.post('/api/notifications/channels/:id/test', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const ch = deps.store.get(c.req.param('id'))
		if (!ch) return c.json({ error: 'not_found' }, 404)
		try {
			await deps.sender.sendTest(ch.kind, ch.config)
			return c.json({ ok: true })
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return c.json({ error: message }, 502)
		}
	})

	app.delete('/api/notifications/channels/:id', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const ok = deps.store.delete(c.req.param('id'))
		if (!ok) return c.json({ error: 'not_found' }, 404)
		return c.json({ ok: true })
	})

	app.get('/api/notifications/deliveries', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const channelId = c.req.query('channelId')
		const deliveries = deps.store.listDeliveries(channelId)
		return c.json({ deliveries })
	})

	app.post('/api/notifications/deliveries/:id/retry', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const ok = await deps.sender.retryDelivery(c.req.param('id'))
		if (!ok) return c.json({ error: 'not_found_or_not_failed' }, 404)
		return c.json({ ok: true })
	})

	app.get('/api/notifications/events', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		return c.json({ events: ALL_EVENTS })
	})
}

function toWire(ch: ChannelRecord): {
	id: string
	name: string
	kind: string
	config: Record<string, unknown>
	subscribedEvents: NotificationEventName[]
	createdAt: string
} {
	return {
		id: ch.id,
		name: ch.name,
		kind: ch.kind,
		config: ch.config as unknown as Record<string, unknown>,
		subscribedEvents: ch.subscribedEvents,
		createdAt: ch.createdAt.toISOString(),
	}
}

function validateChannelBody(body: unknown): string | null {
	if (!body || typeof body !== 'object') return 'expected_object'
	const b = body as Record<string, unknown>
	if (typeof b['name'] !== 'string' || !b['name'].trim()) return 'name_required'
	if (b['kind'] !== 'webhook' && b['kind'] !== 'smtp') return 'invalid_kind'
	if (!b['config'] || typeof b['config'] !== 'object') return 'config_required'
	if (!Array.isArray(b['subscribedEvents'])) return 'subscribedEvents_required'
	return null
}
