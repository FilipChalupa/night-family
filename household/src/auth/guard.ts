import type { Context } from 'hono'
import { getSessionIdFromCookie } from './oauth.ts'
import type { SessionStore } from './sessions.ts'

/**
 * Auth guard for mutating endpoints.
 *
 * Behaviour:
 *   - If OAuth is not configured (dev mode, no GITHUB_OAUTH_*) → allow all
 *     (single-user local development). This makes M1/M2 usable without
 *     setting up an OAuth app.
 *   - If OAuth is configured → require an admin session cookie. CSRF
 *     double-submit lands in a later milestone; for now any valid session
 *     suffices.
 */
export class AdminGuard {
	constructor(
		private readonly sessions: SessionStore,
		private readonly oauthConfigured: boolean,
	) {}

	/**
	 * Returns null when allowed; otherwise a Response to short-circuit the
	 * handler with.
	 */
	requireAdmin(c: Context): Response | null {
		if (!this.oauthConfigured) return null
		const sessionId = getSessionIdFromCookie(c)
		if (!sessionId) {
			return c.json({ error: 'not_authenticated' }, 401)
		}
		const session = this.sessions.get(sessionId)
		if (!session) {
			return c.json({ error: 'session_expired' }, 401)
		}
		if (session.role !== 'admin') {
			return c.json({ error: 'admin_required' }, 403)
		}
		return null
	}
}
