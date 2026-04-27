import { eq, lt } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { randomBytes } from 'node:crypto'
import type { Logger } from 'pino'
import type { Db } from '../db/index.ts'
import { oauthStates } from '../db/schema.ts'
import type { UserStore } from '../users/store.ts'
import { SESSION_COOKIE, SESSION_TTL_MS, type SessionStore } from './sessions.ts'

export interface OAuthDeps {
	clientId: string
	clientSecret: string
	db: Db
	users: UserStore
	sessions: SessionStore
	logger: Logger
}

const STATE_TTL_MS = 10 * 60 * 1000 // 10 min

interface GitHubUser {
	login: string
}

function buildRedirectUri(c: Context): string {
	const url = new URL(c.req.url)
	const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')
	const host = c.req.header('x-forwarded-host') ?? url.host
	return `${proto}://${host}/auth/github/callback`
}

function setSessionCookie(c: Context, sessionId: string): void {
	setCookie(c, SESSION_COOKIE, sessionId, {
		httpOnly: true,
		secure: c.req.url.startsWith('https://'),
		sameSite: 'Lax',
		path: '/',
		maxAge: Math.floor(SESSION_TTL_MS / 1000),
	})
}

export function mountOAuth(app: Hono, deps: OAuthDeps): void {
	app.get('/auth/github', async (c) => {
		const state = randomBytes(24).toString('base64url')
		const redirectTo = c.req.query('redirect_to') ?? '/'
		deps.db
			.insert(oauthStates)
			.values({
				state,
				expiresAt: new Date(Date.now() + STATE_TTL_MS),
				redirectTo,
			})
			.run()

		const redirectUri = buildRedirectUri(c)
		const url = new URL('https://github.com/login/oauth/authorize')
		url.searchParams.set('client_id', deps.clientId)
		url.searchParams.set('redirect_uri', redirectUri)
		url.searchParams.set('scope', 'read:user')
		url.searchParams.set('state', state)
		return c.redirect(url.toString())
	})

	app.get('/auth/github/callback', async (c) => {
		const code = c.req.query('code')
		const state = c.req.query('state')
		if (!code || !state) {
			return c.text('missing code or state', 400)
		}

		// Validate + consume state.
		const stateRows = deps.db
			.select()
			.from(oauthStates)
			.where(eq(oauthStates.state, state))
			.all()
		const stateRow = stateRows[0]
		deps.db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date())).run()
		if (!stateRow || stateRow.expiresAt.getTime() < Date.now()) {
			return c.text('invalid or expired state', 400)
		}
		deps.db.delete(oauthStates).where(eq(oauthStates.state, state)).run()

		// Exchange code → access_token.
		const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				client_id: deps.clientId,
				client_secret: deps.clientSecret,
				code,
				redirect_uri: buildRedirectUri(c),
			}),
		})
		if (!tokenRes.ok) {
			deps.logger.error({ status: tokenRes.status }, 'token exchange failed')
			return c.text('token exchange failed', 502)
		}
		const tokenJson = (await tokenRes.json()) as {
			access_token?: string
			error?: string
		}
		if (!tokenJson.access_token) {
			return c.text(`oauth error: ${tokenJson.error ?? 'unknown'}`, 400)
		}

		// Lookup user.
		const userRes = await fetch('https://api.github.com/user', {
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${tokenJson.access_token}`,
			},
		})
		if (!userRes.ok) {
			return c.text('failed to fetch GitHub user', 502)
		}
		const ghUser = (await userRes.json()) as GitHubUser
		if (!ghUser.login) {
			return c.text('GitHub returned no login', 502)
		}

		const allowed = deps.users.get(ghUser.login)
		if (!allowed) {
			deps.logger.warn({ login: ghUser.login }, 'login attempt by unlisted user')
			return c.text(`User "${ghUser.login}" is not allowed. Ask an admin to add you.`, 403)
		}

		const session = deps.sessions.create(allowed.username, allowed.role)
		setSessionCookie(c, session.id)
		deps.logger.info({ user: allowed.username, role: allowed.role }, 'session created')

		const redirectTo = stateRow.redirectTo ?? '/'
		return c.redirect(redirectTo)
	})

	app.post('/auth/logout', (c) => {
		const sessionId = getSessionIdFromCookie(c)
		if (sessionId) deps.sessions.delete(sessionId)
		deleteCookie(c, SESSION_COOKIE, { path: '/' })
		return c.json({ ok: true })
	})
}

export function mountWhoAmI(
	app: Hono,
	deps: { sessions: SessionStore; oauthConfigured: boolean; requireUiLogin: boolean },
): void {
	app.get('/api/me', (c) => {
		if (!deps.oauthConfigured) {
			return c.json({
				authenticated: false,
				oauth_configured: false,
				require_ui_login: deps.requireUiLogin,
			})
		}
		const id = getSessionIdFromCookie(c)
		if (!id) {
			return c.json({
				authenticated: false,
				oauth_configured: true,
				require_ui_login: deps.requireUiLogin,
			})
		}
		const session = deps.sessions.get(id)
		if (!session) {
			deleteCookie(c, SESSION_COOKIE, { path: '/' })
			return c.json({
				authenticated: false,
				oauth_configured: true,
				require_ui_login: deps.requireUiLogin,
			})
		}
		deps.sessions.maybeRefresh(id)
		return c.json({
			authenticated: true,
			oauth_configured: true,
			require_ui_login: deps.requireUiLogin,
			username: session.githubUsername,
			role: session.role,
			csrfToken: session.csrfToken,
		})
	})
}

export function getSessionIdFromCookie(c: Context): string | null {
	return getSessionIdFromCookieHeader(c.req.header('cookie'))
}

export function getSessionIdFromCookieHeader(raw: string | undefined): string | null {
	const value = raw ?? ''
	for (const part of value.split(';')) {
		const [k, v] = part.trim().split('=', 2)
		if (k === SESSION_COOKIE && v) return v
	}
	return null
}
