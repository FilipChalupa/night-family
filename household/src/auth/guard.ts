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
		const originError = this.requireSameOrigin(c)
		if (originError) return originError
		const session = this.currentSession(c)
		if (!session) {
			return c.json({ error: 'not_authenticated' }, 401)
		}
		return null
	}

	/**
	 * CSRF defense-in-depth for state-changing requests: on unsafe methods,
	 * reject when the browser-set Origin/Referer doesn't match our own host.
	 * This holds even if the session cookie's SameSite is ever loosened, and
	 * needs no client cooperation (browsers always attach Origin to
	 * cross-origin fetch/XHR and form POSTs). Safe methods and requests with
	 * no Origin/Referer (non-browser clients) pass through.
	 */
	private requireSameOrigin(c: Context): Response | null {
		const method = c.req.method.toUpperCase()
		if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
		const origin = c.req.header('origin')
		const referer = c.req.header('referer')
		const source = origin ?? referer
		if (!source) return null
		let sourceHost: string
		try {
			sourceHost = new URL(source).host
		} catch {
			return c.json({ error: 'bad_origin' }, 403)
		}
		const selfHost = c.req.header('x-forwarded-host') ?? new URL(c.req.url).host
		if (sourceHost !== selfHost) {
			return c.json({ error: 'cross_origin_forbidden' }, 403)
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
		const originError = this.requireSameOrigin(c)
		if (originError) return originError
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
