import type { Context } from 'hono'
import { getSessionIdFromCookie } from './oauth.ts'
import type { SessionRecord, SessionStore } from './sessions.ts'

/**
 * Auth guard for web UI and API endpoints.
 *
 * Behaviour:
 *   - If REQUIRE_UI_LOGIN=false → read endpoints are public.
 *   - If REQUIRE_UI_LOGIN=true → any UI/API access requires a valid session.
 *   - Mutating admin endpoints still require role=admin.
 */
export class AdminGuard {
	constructor(
		private readonly sessions: SessionStore,
		private readonly requireUiLogin: boolean,
		private readonly oauthConfigured: boolean,
	) {}

	currentSession(c: Context): SessionRecord | null {
		const sessionId = getSessionIdFromCookie(c)
		if (!sessionId) return null
		return this.sessions.get(sessionId)
	}

	uiLoginRequired(): boolean {
		return this.requireUiLogin
	}

	requireAuthenticated(c: Context): Response | null {
		if (!this.requireUiLogin) return null
		const session = this.currentSession(c)
		if (!session) {
			return c.json({ error: 'not_authenticated' }, 401)
		}
		return null
	}

	requireAuthenticatedPage(c: Context): Response | null {
		if (!this.requireUiLogin) return null
		const session = this.currentSession(c)
		if (session) return null
		const url = new URL(c.req.url)
		const redirectTo = `${url.pathname}${url.search}`
		return c.redirect(`/auth/github?redirect_to=${encodeURIComponent(redirectTo)}`)
	}

	/**
	 * Returns null when allowed; otherwise a Response to short-circuit the
	 * handler with.
	 */
	requireAdmin(c: Context): Response | null {
		if (!this.oauthConfigured) return null
		const session = this.currentSession(c)
		if (!session) {
			return c.json({ error: 'not_authenticated' }, 401)
		}
		if (session.role !== 'admin') {
			return c.json({ error: 'admin_required' }, 403)
		}
		return null
	}
}
