/**
 * End-to-end-ish test of the Member tunnel against real sockets: a real local
 * "dev server" (http + ws), a stand-in Household `/ws/preview` WebSocket server
 * that drives `req.*` / `ws.*` frames, and the real {@link PreviewTunnel}. This
 * exercises the parts that pure unit tests can't — the actual `http.request` to
 * loopback and the WebSocket bridge.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket, WebSocketServer } from 'ws'
import { decodeTunnel, encodeTunnel, type MemberToHouseholdTunnel } from '@night/shared'
import type { Logger } from 'pino'
import { PreviewTunnel } from './preview-tunnel.ts'

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	child: () => silentLogger,
} as unknown as Logger

function listen(server: Server): Promise<number> {
	return new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
	)
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
		await sleep(10)
	}
}

describe('PreviewTunnel (real sockets)', () => {
	const cleanups: Array<() => void> = []
	afterEach(() => {
		for (const c of cleanups.splice(0).reverse()) c()
	})

	/** Spin a Household-side `/ws/preview` server; returns the member's frames + a sender. */
	async function setupTunnel() {
		const house = new WebSocketServer({ host: '127.0.0.1', port: 0 })
		cleanups.push(() => house.close())
		await new Promise<void>((resolve) => house.once('listening', resolve))
		const housePort = (house.address() as { port: number }).port

		const frames: MemberToHouseholdTunnel[] = []
		let houseWs: WebSocket | null = null
		const connected = new Promise<void>((resolve) => {
			house.on('connection', (ws) => {
				houseWs = ws
				ws.on('message', (raw) => {
					const f = decodeTunnel<MemberToHouseholdTunnel>(String(raw))
					if (!f) return
					frames.push(f)
					if (f.t === 'hello') resolve()
				})
			})
		})

		const tunnel = new PreviewTunnel({
			householdUrl: `ws://127.0.0.1:${housePort}`,
			accessToken: 'tok',
			memberId: 'm1',
			logger: silentLogger,
		})
		void tunnel.run()
		cleanups.push(() => tunnel.stop())

		await connected
		return { frames, send: (f: unknown) => houseWs!.send(encodeTunnel(f as never)) }
	}

	it('proxies an HTTP request to the local dev server', async () => {
		const dev = createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end(`hi ${req.url}`)
		})
		cleanups.push(() => dev.close())
		const devPort = await listen(dev)

		const { frames, send } = await setupTunnel()
		send({ t: 'req.head', id: '1', method: 'GET', path: '/page', headers: {}, port: devPort })
		send({ t: 'req.end', id: '1' })

		await waitFor(() => frames.some((f) => f.t === 'res.end' && f.id === '1'))
		const head = frames.find((f) => f.t === 'res.head') as { status: number } | undefined
		expect(head?.status).toBe(200)
		const body = Buffer.concat(
			frames
				.filter(
					(f): f is Extract<MemberToHouseholdTunnel, { t: 'res.data' }> =>
						f.t === 'res.data',
				)
				.map((f) => Buffer.from(f.b64, 'base64')),
		).toString()
		expect(body).toBe('hi /page')
	})

	it('reports res.error when the dev server is down', async () => {
		// A real port we then free, so the connect is refused immediately.
		const tmp = createServer()
		const closedPort = await listen(tmp)
		await new Promise<void>((resolve) => tmp.close(() => resolve()))

		const { frames, send } = await setupTunnel()
		send({ t: 'req.head', id: '9', method: 'GET', path: '/', headers: {}, port: closedPort })
		send({ t: 'req.end', id: '9' })
		await waitFor(() => frames.some((f) => f.t === 'res.error' && f.id === '9'))
	})

	it('bridges a WebSocket to the local dev server and relays both ways', async () => {
		const dev = createServer()
		const devWss = new WebSocketServer({ server: dev })
		devWss.on('connection', (ws) => {
			ws.on('message', (m: Buffer) => ws.send(`echo:${m.toString()}`))
		})
		cleanups.push(() => devWss.close())
		cleanups.push(() => dev.close())
		const devPort = await listen(dev)

		const { frames, send } = await setupTunnel()
		send({ t: 'ws.open', id: 'w1', port: devPort, path: '/', headers: {}, protocols: [] })
		send({ t: 'ws.msg', id: 'w1', b64: Buffer.from('ping').toString('base64'), binary: false })

		await waitFor(() => frames.some((f) => f.t === 'ws.msg'))
		const msg = frames.find((f) => f.t === 'ws.msg') as { b64: string } | undefined
		expect(Buffer.from(msg!.b64, 'base64').toString()).toBe('echo:ping')
	})
})
