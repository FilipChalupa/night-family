import { describe, expect, it } from 'vitest'
import type { Logger } from 'pino'
import {
	DATA_REQ,
	DATA_RES,
	DATA_WS,
	decodeDataFrame,
	decodeTunnel,
	encodeDataFrame,
	type DataFrame,
	type TunnelFrame,
} from '@night/shared'
import { idlePreviewTaskIds, PreviewActivity, PreviewTunnelHub } from './tunnel.ts'

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	child: () => silentLogger,
} as unknown as Logger

const bytes = (s: string) => new Uint8Array(Buffer.from(s))
const streamOf = (s: string): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(c) {
			c.enqueue(bytes(s))
			c.close()
		},
	})
const tick = () => new Promise((r) => setTimeout(r, 10))

/** Registered member that records what the hub sends, split into control / data. */
function setup() {
	const hub = new PreviewTunnelHub(silentLogger)
	const sent: Array<string | Uint8Array> = []
	hub.register('m1', (d) => sent.push(d))
	const controls = (): TunnelFrame[] =>
		sent
			.filter((s): s is string => typeof s === 'string')
			.map((s) => decodeTunnel<TunnelFrame>(s))
			.filter((f): f is TunnelFrame => f !== null)
	const data = (): DataFrame[] =>
		sent
			.filter((s): s is Uint8Array => typeof s !== 'string')
			.map((s) => decodeDataFrame(s))
			.filter((f): f is DataFrame => f !== null)
	return { hub, controls, data }
}

describe('PreviewTunnelHub', () => {
	it('proxies a request and streams the response back', async () => {
		const { hub, controls } = setup()
		const respPromise = hub.proxy('m1', {
			method: 'GET',
			path: '/index.html',
			headers: { accept: 'text/html' },
			port: 3000,
			body: null,
		})

		const head = controls().find((f) => f.t === 'req.head')
		expect(head).toMatchObject({
			t: 'req.head',
			method: 'GET',
			path: '/index.html',
			port: 3000,
		})
		expect(controls().some((f) => f.t === 'req.end')).toBe(true)
		const id = (head as { id: string }).id

		hub.handleMemberFrame('m1', {
			t: 'res.head',
			id,
			status: 200,
			headers: { 'content-type': 'text/html' },
		})
		hub.handleMemberData('m1', encodeDataFrame(DATA_RES, id, bytes('<!doctype html>')))
		hub.handleMemberFrame('m1', { t: 'res.end', id })

		const resp = await respPromise
		expect(resp.status).toBe(200)
		expect(resp.headers.get('content-type')).toBe('text/html')
		expect(await resp.text()).toBe('<!doctype html>')
	})

	it('returns 503 when the member has no tunnel', async () => {
		const hub = new PreviewTunnelHub(silentLogger)
		const resp = await hub.proxy('ghost', {
			method: 'GET',
			path: '/',
			headers: {},
			port: 3000,
			body: null,
		})
		expect(resp.status).toBe(503)
	})

	it('maps a member-side error (before head) to 502', async () => {
		const { hub, controls } = setup()
		const respPromise = hub.proxy('m1', {
			method: 'GET',
			path: '/',
			headers: {},
			port: 3000,
			body: null,
		})
		const id = (controls().find((f) => f.t === 'req.head') as { id: string }).id
		hub.handleMemberFrame('m1', { t: 'res.error', id, message: 'ECONNREFUSED' })
		expect((await respPromise).status).toBe(502)
	})

	it('streams a request body as binary data frames', async () => {
		const { hub, controls, data } = setup()
		void hub.proxy('m1', {
			method: 'POST',
			path: '/api',
			headers: {},
			port: 3000,
			body: streamOf('hello'),
		})
		await tick() // the body pump is async
		const df = data().find((f) => f.kind === DATA_REQ)
		expect(df && Buffer.from(df.payload).toString()).toBe('hello')
		expect(controls().some((f) => f.t === 'req.end')).toBe(true)
	})

	it('preserves multiple set-cookie headers on the response', async () => {
		const { hub, controls } = setup()
		const respPromise = hub.proxy('m1', {
			method: 'GET',
			path: '/',
			headers: {},
			port: 3000,
			body: null,
		})
		const id = (controls().find((f) => f.t === 'req.head') as { id: string }).id
		hub.handleMemberFrame('m1', {
			t: 'res.head',
			id,
			status: 200,
			headers: {},
			setCookies: ['a=1; Path=/', 'b=2; HttpOnly'],
		})
		hub.handleMemberFrame('m1', { t: 'res.end', id })
		const resp = await respPromise
		expect(resp.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; HttpOnly'])
	})

	it('signals backpressure (res.pause) when the consumer is slow', async () => {
		const { hub, controls } = setup()
		const respPromise = hub.proxy('m1', {
			method: 'GET',
			path: '/big',
			headers: {},
			port: 3000,
			body: null,
		})
		const id = (controls().find((f) => f.t === 'req.head') as { id: string }).id
		hub.handleMemberFrame('m1', { t: 'res.head', id, status: 200, headers: {} })
		await respPromise // resolve the Response; nobody reads its body
		// Push past the 256 KB high-water mark without consuming.
		hub.handleMemberData('m1', encodeDataFrame(DATA_RES, id, new Uint8Array(300 * 1024)))
		expect(controls().some((f) => f.t === 'res.pause' && f.id === id)).toBe(true)
	})

	it('bridges a WebSocket: opens, relays both directions, and closes', () => {
		const { hub, controls, data } = setup()
		const browser = {
			text: [] as string[],
			binary: [] as Uint8Array[],
			closed: null as number | null,
		}
		const id = hub.openWsStream(
			'm1',
			{
				sendText: (t) => browser.text.push(t),
				sendBinary: (b) => browser.binary.push(b),
				close: (code) => {
					browser.closed = code ?? 1000
				},
			},
			{ port: 5173, path: '/', headers: {}, protocols: ['vite-hmr'] },
		)
		expect(id).not.toBeNull()
		expect(controls().find((f) => f.t === 'ws.open')).toMatchObject({
			t: 'ws.open',
			port: 5173,
			path: '/',
			protocols: ['vite-hmr'],
		})

		// Dev server → browser (text).
		hub.handleMemberData(
			'm1',
			encodeDataFrame(DATA_WS, id!, bytes('{"type":"connected"}'), false),
		)
		expect(browser.text).toEqual(['{"type":"connected"}'])

		// Browser → dev server.
		hub.wsFromBrowser('m1', id!, 'ping')
		const up = data().find((f) => f.kind === DATA_WS)
		expect(up && Buffer.from(up.payload).toString()).toBe('ping')

		// Dev server closes → browser closed.
		hub.handleMemberFrame('m1', { t: 'ws.close', id: id!, code: 1001 })
		expect(browser.closed).toBe(1001)
	})

	it('returns null opening a WS stream for an offline member', () => {
		const hub = new PreviewTunnelHub(silentLogger)
		const id = hub.openWsStream(
			'ghost',
			{ sendText: () => {}, sendBinary: () => {}, close: () => {} },
			{ port: 5173, path: '/', headers: {}, protocols: [] },
		)
		expect(id).toBeNull()
	})
})

describe('idle preview teardown', () => {
	const now = 1_000_000
	const ttl = 30 * 60_000

	const task = (id: string, kind: string, agoMs: number) => ({
		id,
		kind,
		updatedAt: new Date(now - agoMs).toISOString(),
	})

	it('tracks and forgets activity', () => {
		const a = new PreviewActivity()
		a.touch('t1', now)
		expect(a.lastAt('t1')).toBe(now)
		a.forget('t1')
		expect(a.lastAt('t1')).toBeUndefined()
	})

	it('retain() drops entries not in the keep set', () => {
		const a = new PreviewActivity()
		a.touch('keep', now)
		a.touch('drop', now)
		a.retain(new Set(['keep']))
		expect(a.lastAt('keep')).toBe(now)
		expect(a.lastAt('drop')).toBeUndefined()
	})

	it('picks preview tasks idle past the TTL, using recorded activity', () => {
		const a = new PreviewActivity()
		a.touch('fresh', now - 60_000) // 1 min ago → not idle
		a.touch('stale', now - 40 * 60_000) // 40 min ago → idle
		const tasks = [
			task('fresh', 'preview', 99 * 60_000),
			task('stale', 'preview', 1_000),
			task('impl', 'implement', 99 * 60_000), // not a preview
		]
		expect(idlePreviewTaskIds(tasks, a, ttl, now)).toEqual(['stale'])
	})

	it('falls back to updatedAt when no traffic was recorded', () => {
		const a = new PreviewActivity()
		const tasks = [task('never-opened', 'preview', 45 * 60_000)]
		expect(idlePreviewTaskIds(tasks, a, ttl, now)).toEqual(['never-opened'])
	})
})
