import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { rateLimit } from './rateLimit.ts'

function appWith(max: number, windowMs: number, clock: { t: number }) {
	const app = new Hono()
	app.use('/hook', rateLimit({ windowMs, max, now: () => clock.t, key: () => 'fixed-key' }))
	app.post('/hook', (c) => c.json({ ok: true }))
	return app
}

async function hit(app: Hono) {
	return app.request('/hook', { method: 'POST' })
}

describe('rateLimit', () => {
	it('allows up to max requests then returns 429 with Retry-After', async () => {
		const clock = { t: 1_000 }
		const app = appWith(3, 60_000, clock)

		for (let i = 0; i < 3; i++) expect((await hit(app)).status).toBe(200)

		const blocked = await hit(app)
		expect(blocked.status).toBe(429)
		expect(blocked.headers.get('Retry-After')).toBeTruthy()
		expect(await blocked.json()).toMatchObject({ error: 'rate_limited' })
	})

	it('resets the window after windowMs elapses', async () => {
		const clock = { t: 1_000 }
		const app = appWith(2, 60_000, clock)

		expect((await hit(app)).status).toBe(200)
		expect((await hit(app)).status).toBe(200)
		expect((await hit(app)).status).toBe(429)

		clock.t += 60_001 // window elapsed
		expect((await hit(app)).status).toBe(200)
	})
})
