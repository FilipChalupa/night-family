import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import { AdminGuard } from './guard.ts'
import type { SessionStore } from './sessions.ts'

// The guard only reaches SessionStore after the origin check passes, and only
// when a session cookie is present — none of these tests set one, so a stub is
// never actually called.
const noSessions = {} as unknown as SessionStore

interface CtxOpts {
	method: string
	origin?: string
	referer?: string
	host?: string // x-forwarded-host
	url?: string
}

function fakeCtx(opts: CtxOpts): {
	c: Context
	jsonCalls: Array<{ body: unknown; status: number }>
} {
	const headers: Record<string, string | undefined> = {
		origin: opts.origin,
		referer: opts.referer,
		'x-forwarded-host': opts.host,
	}
	const jsonCalls: Array<{ body: unknown; status: number }> = []
	const c = {
		req: {
			method: opts.method,
			url: opts.url ?? 'http://app.example/api/x',
			header: (name: string) => headers[name.toLowerCase()],
		},
		json: (body: unknown, status = 200) => {
			jsonCalls.push({ body, status })
			return { body, status } as unknown as Response
		},
	} as unknown as Context
	return { c, jsonCalls }
}

describe('AdminGuard same-origin (CSRF) check', () => {
	const guard = new AdminGuard(noSessions, true /* requireUiLogin */, true /* oauthConfigured */)

	it('rejects a cross-origin mutating request with 403', () => {
		const { c } = fakeCtx({
			method: 'POST',
			origin: 'https://evil.example',
			host: 'app.example',
		})
		const res = guard.requireAdmin(c) as unknown as { status: number; body: { error: string } }
		expect(res).not.toBeNull()
		expect(res.status).toBe(403)
		expect(res.body.error).toBe('cross_origin_forbidden')
	})

	it('lets a same-origin mutating request through the origin check (then hits auth)', () => {
		const { c } = fakeCtx({
			method: 'POST',
			origin: 'https://app.example',
			host: 'app.example',
		})
		// Origin matches → passes the CSRF check, falls through to the session
		// check, which fails (no cookie) with 401 — not the 403 above.
		const res = guard.requireAdmin(c) as unknown as { status: number; body: { error: string } }
		expect(res.status).toBe(401)
		expect(res.body.error).toBe('not_authenticated')
	})

	it('does not apply the origin check to safe (GET) methods', () => {
		const { c } = fakeCtx({
			method: 'GET',
			origin: 'https://evil.example',
			host: 'app.example',
		})
		const res = guard.requireAdmin(c) as unknown as { status: number; body: { error: string } }
		// Cross-origin but a safe method → skipped; falls straight to auth.
		expect(res.status).toBe(401)
		expect(res.body.error).toBe('not_authenticated')
	})

	it('allows a mutating request with no Origin/Referer (non-browser client)', () => {
		const { c } = fakeCtx({ method: 'DELETE', host: 'app.example' })
		const res = guard.requireAdmin(c) as unknown as { status: number; body: { error: string } }
		expect(res.status).toBe(401) // origin check skipped, auth still required
	})

	it('honours x-forwarded-host over the request URL host', () => {
		const { c } = fakeCtx({
			method: 'POST',
			origin: 'https://public.example',
			host: 'public.example', // proxy-forwarded public host
			url: 'http://127.0.0.1:8080/api/x', // internal origin URL
		})
		const res = guard.requireAdmin(c) as unknown as { status: number; body: { error: string } }
		// Origin matches the forwarded host → not a cross-origin rejection.
		expect(res.status).toBe(401)
	})

	it('falls back to Referer when Origin is absent', () => {
		const { c } = fakeCtx({
			method: 'POST',
			referer: 'https://evil.example/some/page',
			host: 'app.example',
		})
		const res = guard.requireAdmin(c) as unknown as { status: number; body: { error: string } }
		expect(res.status).toBe(403)
		expect(res.body.error).toBe('cross_origin_forbidden')
	})
})
