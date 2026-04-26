import type { Hono } from 'hono'
import type { AdminGuard } from '../auth/guard.ts'
import type { UserRole, UserStore } from './store.ts'

export interface UsersApiDeps {
	users: UserStore
	guard: AdminGuard
}

export function mountUsersApi(app: Hono, deps: UsersApiDeps): void {
	app.get('/api/users', (c) => {
		const guardResult = deps.guard.requireAuthenticated(c)
		if (guardResult) return guardResult
		return c.json({
			primaryAdmin: deps.users.primaryAdmin(),
			users: deps.users.list(),
		})
	})

	app.post('/api/users', async (c) => {
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
		const username = b['username']
		const role = b['role']
		if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
			return c.json({ error: 'invalid_username' }, 400)
		}
		if (role !== 'admin' && role !== 'readonly') {
			return c.json({ error: 'invalid_role' }, 400)
		}

		const actor = deps.guard.currentSession(c)
		if (!actor) return c.json({ error: 'not_authenticated' }, 401)

		try {
			const user = deps.users.add(username, role, actor.githubUsername)
			return c.json({ user }, 201)
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : 'user_add_failed' },
				400,
			)
		}
	})

	app.patch('/api/users/:username', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult

		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		if (!body || typeof body !== 'object') return c.json({ error: 'expected_object' }, 400)
		const role = (body as Record<string, unknown>)['role']
		if (role !== 'admin' && role !== 'readonly') {
			return c.json({ error: 'invalid_role' }, 400)
		}

		try {
			const ok = deps.users.setRole(c.req.param('username'), role as UserRole)
			if (!ok) return c.json({ error: 'not_found' }, 404)
			return c.json({ ok: true })
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : 'user_update_failed' },
				400,
			)
		}
	})

	app.delete('/api/users/:username', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		try {
			const ok = deps.users.remove(c.req.param('username'))
			if (!ok) return c.json({ error: 'not_found' }, 404)
			return c.json({ ok: true })
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : 'user_delete_failed' },
				400,
			)
		}
	})
}

const USERNAME_RE = /^[A-Za-z0-9-]+$/
