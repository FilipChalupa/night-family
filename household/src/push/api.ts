import type { Hono } from 'hono'
import type { AdminGuard } from '../auth/guard.ts'
import type { PushSubscriptionStore } from './store.ts'
import type { VapidKeys } from './vapid.ts'

interface Deps {
	store: PushSubscriptionStore
	keys: VapidKeys
	guard: AdminGuard
}

export function mountPushApi(app: Hono, deps: Deps): void {
	// Public key has to be readable before the user is even prompted, so it's
	// gated only by `requireAuthenticated` (matches the existing /api/me pattern).
	app.get('/api/push/public-key', (c) => {
		const guardResult = deps.guard.requireAuthenticated(c)
		if (guardResult) return guardResult
		return c.json({ publicKey: deps.keys.publicKey })
	})

	app.post('/api/push/subscribe', async (c) => {
		const guardResult = deps.guard.requireAuthenticated(c)
		if (guardResult) return guardResult
		const actor = deps.guard.currentSession(c)
		const userLogin = actor?.githubUsername ?? 'anonymous'

		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		const parsed = parseSubscription(body)
		if ('error' in parsed) return c.json(parsed, 400)

		const record = deps.store.upsert({
			userLogin,
			endpoint: parsed.endpoint,
			p256dh: parsed.p256dh,
			auth: parsed.auth,
		})
		return c.json({ ok: true, id: record.id })
	})

	app.delete('/api/push/subscribe', async (c) => {
		const guardResult = deps.guard.requireAuthenticated(c)
		if (guardResult) return guardResult
		const actor = deps.guard.currentSession(c)
		const userLogin = actor?.githubUsername ?? 'anonymous'
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		if (!body || typeof body !== 'object') return c.json({ error: 'expected_object' }, 400)
		const endpoint = (body as { endpoint?: unknown }).endpoint
		if (typeof endpoint !== 'string' || endpoint.length === 0) {
			return c.json({ error: 'invalid_endpoint' }, 400)
		}
		// Scope to the caller so one user can't delete another's subscription by
		// its endpoint (subscriptions are keyed by userLogin on create).
		const removed = deps.store.deleteByEndpointForUser(endpoint, userLogin)
		return c.json({ ok: true, removed })
	})
}

/**
 * Validate the shape the browser's `PushSubscription.toJSON()` produces.
 * The `keys.p256dh` and `keys.auth` arrive as URL-safe base64 strings; we
 * keep them as-is since `web-push` expects exactly that.
 */
function parseSubscription(body: unknown):
	| { error: string }
	| {
			endpoint: string
			p256dh: string
			auth: string
	  } {
	if (!body || typeof body !== 'object') return { error: 'expected_object' }
	const b = body as Record<string, unknown>
	const endpoint = b['endpoint']
	if (typeof endpoint !== 'string' || endpoint.length === 0) {
		return { error: 'invalid_endpoint' }
	}
	const keys = b['keys']
	if (!keys || typeof keys !== 'object') return { error: 'invalid_keys' }
	const k = keys as Record<string, unknown>
	const p256dh = k['p256dh']
	const auth = k['auth']
	if (typeof p256dh !== 'string' || typeof auth !== 'string') {
		return { error: 'invalid_keys' }
	}
	return { endpoint, p256dh, auth }
}
