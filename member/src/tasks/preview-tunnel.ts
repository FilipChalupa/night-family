/**
 * Member side of the preview tunnel. Opens a dedicated `/ws/preview` WebSocket
 * to the Household (Member-initiated, so NAT is a non-issue) and serves the
 * `req.*` frames the Household sends by proxying them to the preview's local
 * dev server (`127.0.0.1:<port>`), streaming the response back as `res.*`.
 *
 * Only opened by Members that advertise the `preview` skill. Reconnects with
 * backoff like the main connection. v1 handles plain HTTP; WebSocket upgrades
 * (HMR) are a later phase.
 */

import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
	decodeTunnel,
	encodeTunnel,
	type HouseholdToMemberTunnel,
	type MemberToHouseholdTunnel,
	type TunnelReqHead,
} from '@night/shared'
import type { Logger } from 'pino'

const BACKOFF_STEPS_MS = [1_000, 5_000, 30_000, 60_000]

export interface PreviewTunnelOpts {
	/** Same base URL the Member uses for the control WS (`ws(s)://…`). */
	householdUrl: string
	accessToken: string
	memberId: string
	logger: Logger
}

export class PreviewTunnel {
	private ws: WebSocket | null = null
	private shuttingDown = false
	/** In-flight proxied requests, by stream id, so body/abort frames can find them. */
	private readonly inflight = new Map<string, ClientRequest>()

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
		for (const req of this.inflight.values()) req.destroy()
		this.inflight.clear()
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'shutdown')
		this.ws = null
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
			ws.on('message', (data) => this.handleFrame(data.toString()))
			ws.on('close', () => {
				this.ws = null
				for (const req of this.inflight.values()) req.destroy()
				this.inflight.clear()
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

	private handleFrame(raw: string): void {
		const frame = decodeTunnel<HouseholdToMemberTunnel>(raw)
		if (!frame) return
		switch (frame.t) {
			case 'req.head':
				this.startRequest(frame)
				break
			case 'req.data': {
				const req = this.inflight.get(frame.id)
				req?.write(Buffer.from(frame.b64, 'base64'))
				break
			}
			case 'req.end':
				this.inflight.get(frame.id)?.end()
				break
			case 'req.abort': {
				const req = this.inflight.get(frame.id)
				if (req) {
					req.destroy()
					this.inflight.delete(frame.id)
				}
				break
			}
		}
	}

	private startRequest(frame: TunnelReqHead): void {
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
				this.send({
					t: 'res.head',
					id: frame.id,
					status: res.statusCode ?? 502,
					headers: flattenHeaders(res.headers),
				})
				res.on('data', (chunk: Buffer) =>
					this.send({ t: 'res.data', id: frame.id, b64: chunk.toString('base64') }),
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
		this.inflight.set(frame.id, req)
	}
}

/** Flatten Node's `IncomingHttpHeaders` (values can be string[]) to a string map. */
function flattenHeaders(h: IncomingHttpHeaders): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(h)) {
		if (v === undefined) continue
		out[k] = Array.isArray(v) ? v.join(', ') : v
	}
	return out
}
