import { describe, expect, it } from 'vitest'
import type { Logger } from 'pino'
import type { TunnelFrame } from '@night/shared'
import { PreviewTunnelHub } from './tunnel.ts'

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	child: () => silentLogger,
} as unknown as Logger

function b64(s: string): string {
	return Buffer.from(s).toString('base64')
}

describe('PreviewTunnelHub', () => {
	it('proxies a request and streams the response back', async () => {
		const hub = new PreviewTunnelHub(silentLogger)
		const sent: TunnelFrame[] = []
		hub.register('m1', (f) => sent.push(f))

		const respPromise = hub.proxy('m1', {
			method: 'GET',
			path: '/index.html',
			headers: { accept: 'text/html' },
			port: 3000,
			bodyBytes: null,
		})

		// Household should have framed the request out to the member.
		const head = sent.find((f) => f.t === 'req.head')
		expect(head).toMatchObject({
			t: 'req.head',
			method: 'GET',
			path: '/index.html',
			port: 3000,
		})
		expect(sent.some((f) => f.t === 'req.end')).toBe(true)
		const id = (head as { id: string }).id

		// Member answers.
		hub.handleMemberFrame('m1', {
			t: 'res.head',
			id,
			status: 200,
			headers: { 'content-type': 'text/html' },
		})
		hub.handleMemberFrame('m1', { t: 'res.data', id, b64: b64('<!doctype html>') })
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
			bodyBytes: null,
		})
		expect(resp.status).toBe(503)
	})

	it('maps a member-side error (before head) to 502', async () => {
		const hub = new PreviewTunnelHub(silentLogger)
		const sent: TunnelFrame[] = []
		hub.register('m1', (f) => sent.push(f))
		const respPromise = hub.proxy('m1', {
			method: 'GET',
			path: '/',
			headers: {},
			port: 3000,
			bodyBytes: null,
		})
		const id = (sent.find((f) => f.t === 'req.head') as { id: string }).id
		hub.handleMemberFrame('m1', { t: 'res.error', id, message: 'ECONNREFUSED' })
		const resp = await respPromise
		expect(resp.status).toBe(502)
	})

	it('forwards a request body as a req.data frame', async () => {
		const hub = new PreviewTunnelHub(silentLogger)
		const sent: TunnelFrame[] = []
		hub.register('m1', (f) => sent.push(f))
		void hub.proxy('m1', {
			method: 'POST',
			path: '/api',
			headers: {},
			port: 3000,
			bodyBytes: new Uint8Array(Buffer.from('hello')),
		})
		const data = sent.find((f) => f.t === 'req.data') as { b64: string } | undefined
		expect(data?.b64).toBe(b64('hello'))
	})

	it('bridges a WebSocket: opens, relays both directions, and closes', () => {
		const hub = new PreviewTunnelHub(silentLogger)
		const sent: TunnelFrame[] = []
		hub.register('m1', (f) => sent.push(f))

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
		const open = sent.find((f) => f.t === 'ws.open')
		expect(open).toMatchObject({ t: 'ws.open', port: 5173, path: '/', protocols: ['vite-hmr'] })

		// Dev server → browser (text).
		hub.handleMemberFrame('m1', {
			t: 'ws.msg',
			id: id!,
			b64: b64('{"type":"connected"}'),
			binary: false,
		})
		expect(browser.text).toEqual(['{"type":"connected"}'])

		// Browser → dev server.
		hub.wsFromBrowser('m1', id!, 'ping')
		const up = sent.find((f) => f.t === 'ws.msg') as
			| { b64: string; binary: boolean }
			| undefined
		expect(up).toMatchObject({ b64: b64('ping'), binary: false })

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
