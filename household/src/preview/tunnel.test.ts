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
		hub.handleResFrame('m1', {
			t: 'res.head',
			id,
			status: 200,
			headers: { 'content-type': 'text/html' },
		})
		hub.handleResFrame('m1', { t: 'res.data', id, b64: b64('<!doctype html>') })
		hub.handleResFrame('m1', { t: 'res.end', id })

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
		hub.handleResFrame('m1', { t: 'res.error', id, message: 'ECONNREFUSED' })
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
})
