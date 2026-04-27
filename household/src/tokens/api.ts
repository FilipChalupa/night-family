import type { Hono } from 'hono'
import type { AdminGuard } from '../auth/guard.ts'
import type { NotificationSender } from '../notifications/sender.ts'
import type { TokenStore } from './auth.ts'

export interface TokensApiDeps {
	tokens: TokenStore
	guard: AdminGuard
	notifSender?: NotificationSender
}

export function mountTokensApi(app: Hono, deps: TokensApiDeps): void {
	app.get('/api/tokens', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const list = deps.tokens.list().map((t) => ({
			id: t.id,
			name: t.name,
			created_at: t.created_at,
			created_by: t.created_by,
			revoked_at: t.revoked_at,
			revoked_by: t.revoked_by ?? null,
			usage_count: t.usage?.length ?? 0,
		}))
		return c.json({ tokens: list })
	})

	app.get('/api/tokens/:id/audit', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const token = deps.tokens.list().find((t) => t.id === c.req.param('id'))
		if (!token) return c.json({ error: 'not_found' }, 404)
		return c.json({
			id: token.id,
			name: token.name,
			created_at: token.created_at,
			created_by: token.created_by,
			revoked_at: token.revoked_at,
			revoked_by: token.revoked_by ?? null,
			usage: token.usage ?? [],
		})
	})

	app.post('/api/tokens', async (c) => {
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
		const name = b['name']
		if (typeof name !== 'string' || name.trim().length === 0) {
			return c.json({ error: 'name_required' }, 400)
		}

		const actor = deps.guard.currentSession(c)
		if (!actor) return c.json({ error: 'not_authenticated' }, 401)

		const { raw, record } = deps.tokens.create(name.trim(), actor.githubUsername)
		return c.json(
			{
				token: raw,
				record: {
					id: record.id,
					name: record.name,
					created_at: record.created_at,
					created_by: record.created_by,
					revoked_at: null,
					revoked_by: null,
					usage_count: 0,
				},
			},
			201,
		)
	})

	app.delete('/api/tokens/:id', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult

		const actor = deps.guard.currentSession(c)
		if (!actor) return c.json({ error: 'not_authenticated' }, 401)

		const id = c.req.param('id')
		const token = deps.tokens.list().find((t) => t.id === id)
		const ok = deps.tokens.revoke(id, actor.githubUsername)
		if (!ok) return c.json({ error: 'not_found_or_already_revoked' }, 404)
		deps.notifSender
			?.fire('token.revoked', { tokenId: id, tokenName: token?.name ?? id, revokedBy: actor.githubUsername })
			.catch(() => undefined)
		return c.json({ ok: true })
	})
}
