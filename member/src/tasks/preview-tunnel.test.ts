/**
 * End-to-end-ish test of the Member tunnel against real sockets: a real local
 * "dev server" (http + ws), a stand-in Household `/ws/preview` WebSocket server
 * that drives control + data frames, and the real {@link PreviewTunnel}. This
 * exercises the parts that pure unit tests can't — the actual `http.request` to
 * loopback and the WebSocket bridge.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket, WebSocketServer } from 'ws'
import {
	DATA_RES,
	DATA_WS,
	decodeDataFrame,
	decodeTunnel,
	encodeDataFrame,
	encodeTunnel,
	type DataFrame,
	type HouseholdToMemberTunnel,
	type MemberToHouseholdTunnel,
} from '@night/shared'
import type { Logger } from 'pino'
import { PreviewTunnel } from './preview-tunnel.ts'
import { PreviewWaker } from './preview-waker.ts'

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

	/** Spin a Household-side `/ws/preview` server; capture the member's frames. */
	async function setupTunnel() {
		const house = new WebSocketServer({ host: '127.0.0.1', port: 0 })
		cleanups.push(() => house.close())
		await new Promise<void>((resolve) => house.once('listening', resolve))
		const housePort = (house.address() as { port: number }).port

		const control: MemberToHouseholdTunnel[] = []
		const data: DataFrame[] = []
		let houseWs: WebSocket | null = null
		const connected = new Promise<void>((resolve) => {
			house.on('connection', (ws) => {
				houseWs = ws
				ws.on('message', (raw: Buffer, isBinary: boolean) => {
					if (isBinary) {
						const f = decodeDataFrame(raw)
						if (f) data.push(f)
						return
					}
					const f = decodeTunnel<MemberToHouseholdTunnel>(String(raw))
					if (!f) return
					control.push(f)
					if (f.t === 'hello') resolve()
				})
			})
		})

		const tunnel = new PreviewTunnel({
			householdUrl: `ws://127.0.0.1:${housePort}`,
			accessToken: 'tok',
			getSessionId: () => 'sess-1',
			waker: new PreviewWaker(),
			logger: silentLogger,
		})
		void tunnel.run()
		cleanups.push(() => tunnel.stop())

		await connected
		return {
			control,
			data,
			sendControl: (f: HouseholdToMemberTunnel) => houseWs!.send(encodeTunnel(f)),
			sendData: (b: Uint8Array) => houseWs!.send(b, { binary: true }),
		}
	}

	it('proxies an HTTP request to the local dev server', async () => {
		const dev = createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end(`hi ${req.url}`)
		})
		cleanups.push(() => dev.close())
		const devPort = await listen(dev)

		const { control, data, sendControl } = await setupTunnel()
		sendControl({
			t: 'req.head',
			id: '1',
			method: 'GET',
			path: '/page',
			headers: {},
			port: devPort,
		})
		sendControl({ t: 'req.end', id: '1' })

		await waitFor(() => control.some((f) => f.t === 'res.end' && f.id === '1'))
		const head = control.find((f) => f.t === 'res.head') as { status: number } | undefined
		expect(head?.status).toBe(200)
		const body = Buffer.concat(
			data
				.filter((f) => f.kind === DATA_RES && f.id === '1')
				.map((f) => Buffer.from(f.payload)),
		).toString()
		expect(body).toBe('hi /page')
	})

	it('reports res.error when the dev server is down', async () => {
		const tmp = createServer()
		const closedPort = await listen(tmp)
		await new Promise<void>((resolve) => tmp.close(() => resolve()))

		const { control, sendControl } = await setupTunnel()
		sendControl({
			t: 'req.head',
			id: '9',
			method: 'GET',
			path: '/',
			headers: {},
			port: closedPort,
		})
		sendControl({ t: 'req.end', id: '9' })
		await waitFor(() => control.some((f) => f.t === 'res.error' && f.id === '9'))
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

		const { data, sendControl, sendData } = await setupTunnel()
		sendControl({
			t: 'ws.open',
			id: 'w1',
			port: devPort,
			path: '/',
			headers: {},
			protocols: [],
		})
		sendData(encodeDataFrame(DATA_WS, 'w1', new Uint8Array(Buffer.from('ping')), false))

		await waitFor(() => data.some((f) => f.kind === DATA_WS))
		const msg = data.find((f) => f.kind === DATA_WS)
		expect(msg && Buffer.from(msg.payload).toString()).toBe('echo:ping')
	})
})
