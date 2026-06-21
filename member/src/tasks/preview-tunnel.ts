/**
 * Member side of the preview tunnel. Opens a dedicated `/ws/preview` WebSocket
 * to the Household (Member-initiated, so NAT is a non-issue) and serves the
 * frames the Household sends by proxying them to the preview's local dev server
 * (`127.0.0.1:<port>`), streaming the response back.
 *
 * Control frames are JSON text; request/response bodies and bridged WebSocket
 * messages are binary data frames (no base64). The Household applies
 * backpressure via `res.pause`/`res.resume`, which pause/resume the upstream
 * dev-server response so a slow client can't make us buffer unboundedly.
 *
 * Only opened by Members that advertise the `preview` skill. Reconnects with
 * backoff like the main connection.
 */

import {
	request as httpRequest,
	type ClientRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
} from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
	DATA_REQ,
	DATA_RES,
	DATA_WS,
	decodeDataFrame,
	decodeTunnel,
	encodeDataFrame,
	encodeTunnel,
	type HouseholdToMemberTunnel,
	type MemberToHouseholdTunnel,
	type TunnelReqHead,
	type TunnelWsOpen,
} from '@night/shared'
import type { Logger } from 'pino'
import type { PreviewWaker } from './preview-waker.ts'

const BACKOFF_STEPS_MS = [1_000, 5_000, 30_000, 60_000]

interface Inflight {
	/** null while the preview is being woken — body/end are buffered until then. */
	req: ClientRequest | null
	res: IncomingMessage | null
	ended: boolean
	bodyQueue: Buffer[]
}

interface WsBridge {
	/** null while the preview is being woken — messages queue until the socket exists. */
	socket: WebSocket | null
	open: boolean
	queue: Array<{ buf: Buffer; binary: boolean }>
}

export interface PreviewTunnelOpts {
	/** Same base URL the Member uses for the control WS (`ws(s)://…`). */
	householdUrl: string
	accessToken: string
	memberId: string
	/** Wakes an idle (sleeping) preview before proxying a request to it. */
	waker: PreviewWaker
	logger: Logger
}

export class PreviewTunnel {
	private ws: WebSocket | null = null
	private shuttingDown = false
	/** In-flight proxied requests, by stream id. */
	private readonly inflight = new Map<string, Inflight>()
	/** Bridged WebSocket connections (HMR), by stream id. */
	private readonly wsBridges = new Map<string, WsBridge>()

	constructor(private readonly opts: PreviewTunnelOpts) {}

	async run(): Promise<void> {
		let attempt = 0
		while (!this.shuttingDown) {
			try {
				await this.connectOnce()
				attempt = 0
			} catch (err) {
				this.opts.logger.warn(
					{ err: (err as Error).message },
					'preview tunnel connect failed',
				)
			}
			if (this.shuttingDown) return
			const delay = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)]!
			attempt += 1
			await sleep(delay)
		}
	}

	stop(): void {
		this.shuttingDown = true
		this.dropAll()
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'shutdown')
		this.ws = null
	}

	private dropAll(): void {
		for (const { req } of this.inflight.values()) req?.destroy()
		this.inflight.clear()
		for (const bridge of this.wsBridges.values()) bridge.socket?.close()
		this.wsBridges.clear()
	}

	private connectOnce(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = this.opts.householdUrl.replace(/\/$/, '') + '/ws/preview'
			const ws = new WebSocket(url, {
				headers: { Authorization: `Bearer ${this.opts.accessToken}` },
			})
			this.ws = ws

			ws.on('open', () => {
				this.opts.logger.info('preview tunnel open')
				this.send({ t: 'hello', member_id: this.opts.memberId })
			})
			ws.on('message', (data: Buffer, isBinary: boolean) => {
				if (isBinary) this.handleData(data)
				else this.handleControl(data.toString())
			})
			ws.on('close', () => {
				this.ws = null
				this.dropAll()
				resolve()
			})
			ws.on('error', (err) => {
				if (ws.readyState === WebSocket.CONNECTING) reject(err)
			})
		})
	}

	private send(frame: MemberToHouseholdTunnel): void {
		const ws = this.ws
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeTunnel(frame))
	}

	private sendData(bytes: Uint8Array): void {
		const ws = this.ws
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes, { binary: true })
	}

	private handleData(buf: Buffer): void {
		const frame = decodeDataFrame(buf)
		if (!frame) return
		if (frame.kind === DATA_REQ) {
			const entry = this.inflight.get(frame.id)
			if (!entry) return
			const body = Buffer.from(frame.payload)
			if (entry.req) entry.req.write(body)
			else entry.bodyQueue.push(body)
		} else if (frame.kind === DATA_WS) {
			const bridge = this.wsBridges.get(frame.id)
			if (!bridge) return
			const body = Buffer.from(frame.payload)
			if (bridge.socket && bridge.open) bridge.socket.send(body, { binary: frame.binary })
			else bridge.queue.push({ buf: body, binary: frame.binary })
		}
	}

	private handleControl(raw: string): void {
		const frame = decodeTunnel<HouseholdToMemberTunnel>(raw)
		if (!frame) return
		switch (frame.t) {
			case 'req.head':
				void this.startRequest(frame)
				break
			case 'req.end': {
				const entry = this.inflight.get(frame.id)
				if (!entry) break
				if (entry.req) entry.req.end()
				else entry.ended = true
				break
			}
			case 'req.abort': {
				const entry = this.inflight.get(frame.id)
				if (entry) {
					entry.req?.destroy()
					this.inflight.delete(frame.id)
				}
				break
			}
			case 'res.pause':
				this.inflight.get(frame.id)?.res?.pause()
				break
			case 'res.resume':
				this.inflight.get(frame.id)?.res?.resume()
				break
			case 'ws.open':
				void this.openWsBridge(frame)
				break
			case 'ws.close': {
				const bridge = this.wsBridges.get(frame.id)
				bridge?.socket?.close(frame.code, frame.reason)
				this.wsBridges.delete(frame.id)
				break
			}
		}
	}

	private async startRequest(frame: TunnelReqHead): Promise<void> {
		// Reserve the stream first so body/end frames that arrive while we wake
		// the (possibly sleeping) preview are buffered rather than lost.
		const entry: Inflight = { req: null, res: null, ended: false, bodyQueue: [] }
		this.inflight.set(frame.id, entry)

		try {
			await this.opts.waker.ensureAwake(frame.port)
		} catch (err) {
			this.send({ t: 'res.error', id: frame.id, message: (err as Error).message })
			this.inflight.delete(frame.id)
			return
		}
		// Aborted (or the socket dropped) while waking.
		if (this.inflight.get(frame.id) !== entry) return

		const headers = { ...frame.headers }
		// Dev servers (Vite et al.) validate Host; rewrite it to the loopback
		// origin so the proxied request looks local. Drop hop-by-hop headers
		// node manages itself.
		headers['host'] = `127.0.0.1:${frame.port}`
		delete headers['connection']
		delete headers['transfer-encoding']
		delete headers['upgrade']

		const req = httpRequest(
			{
				host: '127.0.0.1',
				port: frame.port,
				method: frame.method,
				path: frame.path,
				headers,
			},
			(res) => {
				entry.res = res
				const setCookies = res.headers['set-cookie']
				this.send({
					t: 'res.head',
					id: frame.id,
					status: res.statusCode ?? 502,
					headers: flattenHeaders(res.headers),
					...(setCookies && setCookies.length > 0 ? { setCookies } : {}),
				})
				res.on('data', (chunk: Buffer) =>
					this.sendData(encodeDataFrame(DATA_RES, frame.id, chunk)),
				)
				res.on('end', () => {
					this.send({ t: 'res.end', id: frame.id })
					this.inflight.delete(frame.id)
				})
			},
		)
		req.on('error', (err) => {
			this.send({ t: 'res.error', id: frame.id, message: err.message })
			this.inflight.delete(frame.id)
		})
		entry.req = req
		for (const chunk of entry.bodyQueue) req.write(chunk)
		entry.bodyQueue = []
		this.opts.waker.touch(frame.port)
		if (entry.ended) req.end()
	}

	/**
	 * Bridge a browser WebSocket (the Household holds the browser side) to a
	 * Member-local one — the dev server's HMR socket. Messages the Household
	 * forwards before the local socket finishes connecting are queued and
	 * flushed on open.
	 */
	private async openWsBridge(frame: TunnelWsOpen): Promise<void> {
		// Reserve the bridge so messages arriving while we wake the preview queue
		// rather than drop.
		const bridge: WsBridge = { socket: null, open: false, queue: [] }
		this.wsBridges.set(frame.id, bridge)

		try {
			await this.opts.waker.ensureAwake(frame.port)
		} catch (err) {
			this.send({ t: 'ws.error', id: frame.id, message: (err as Error).message })
			this.wsBridges.delete(frame.id)
			return
		}
		if (this.wsBridges.get(frame.id) !== bridge) return // closed while waking
		this.opts.waker.touch(frame.port)

		const headers = { ...frame.headers }
		delete headers['host']
		delete headers['connection']
		delete headers['upgrade']
		// The ws library sets these from the handshake itself; passing them
		// through would corrupt the upstream upgrade.
		for (const k of Object.keys(headers)) {
			if (k.toLowerCase().startsWith('sec-websocket-')) delete headers[k]
		}

		const target = `ws://127.0.0.1:${frame.port}${frame.path}`
		const socket = new WebSocket(target, frame.protocols ?? [], { headers })
		bridge.socket = socket

		socket.on('open', () => {
			bridge.open = true
			for (const m of bridge.queue) socket.send(m.buf, { binary: m.binary })
			bridge.queue = []
		})
		socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
			const buf = Array.isArray(data)
				? Buffer.concat(data)
				: Buffer.isBuffer(data)
					? data
					: Buffer.from(data)
			this.sendData(encodeDataFrame(DATA_WS, frame.id, buf, isBinary))
		})
		socket.on('close', (code: number, reason: Buffer) => {
			this.send({ t: 'ws.close', id: frame.id, code, reason: reason.toString() })
			this.wsBridges.delete(frame.id)
		})
		socket.on('error', (err: Error) => {
			this.send({ t: 'ws.error', id: frame.id, message: err.message })
			this.wsBridges.delete(frame.id)
		})
	}
}

/**
 * Flatten Node's `IncomingHttpHeaders` to a string map. `set-cookie` is dropped
 * here — it's carried separately on the frame so its several values survive.
 */
function flattenHeaders(h: IncomingHttpHeaders): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(h)) {
		if (v === undefined || k.toLowerCase() === 'set-cookie') continue
		out[k] = Array.isArray(v) ? v.join(', ') : v
	}
	return out
}
