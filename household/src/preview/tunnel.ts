/**
 * Household side of the preview tunnel.
 *
 *   - `/ws/preview` — a Member-opened WebSocket; the Member registers itself
 *     (`hello`) and then answers `req.*` frames with `res.*` ones.
 *   - host middleware — intercepts requests whose Host is a preview subdomain
 *     (`p<port>-<task>.<previewsDomain>`), looks up the owning Member's tunnel,
 *     and proxies the HTTP request/response over it.
 *
 * The Member opens the socket (NAT-friendly: Household is the only inbound
 * surface). Control frames are JSON text; bodies and bridged WebSocket
 * messages are binary data frames. Response bodies honour backpressure: when
 * the browser-side stream backs up we send `res.pause`, and `res.resume` once
 * it drains, so a slow client can't make us buffer unboundedly.
 */

import type { Context, MiddlewareHandler } from 'hono'
import type { WSContext } from 'hono/ws'
import {
	DATA_RES,
	DATA_WS,
	decodeDataFrame,
	decodeTunnel,
	encodeDataFrame,
	encodeTunnel,
	parsePreviewHost,
	DATA_REQ,
	type MemberToHouseholdTunnel,
} from '@night/shared'
import type { Logger } from 'pino'
import type { TaskStatus } from '@night/shared'
import type { TaskStore } from '../tasks/store.ts'
import type { TokenStore } from '../tokens/auth.ts'
import { previewPortsOf } from './proxy.ts'

const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
])

/** How long a proxied request waits for the Member's first response frame. */
const HEAD_TIMEOUT_MS = 30_000

interface StreamHandlers {
	onHead: (status: number, headers: Record<string, string>, setCookies: string[]) => void
	onData: (bytes: Uint8Array) => void
	onEnd: () => void
	onError: (message: string) => void
}

/** The browser side of a bridged preview WebSocket (HMR). */
interface WsStream {
	sendText: (text: string) => void
	sendBinary: (bytes: Uint8Array) => void
	close: (code?: number, reason?: string) => void
}

interface MemberTunnel {
	/** Raw WS send — a JSON control frame (string) or a binary data frame. */
	send: (data: string | Uint8Array) => void
	streams: Map<string, StreamHandlers>
	wsStreams: Map<string, WsStream>
}

/**
 * Tracks the live `/ws/preview` sockets (one per Member) and multiplexes
 * inbound HTTP requests over them.
 */
export class PreviewTunnelHub {
	private readonly members = new Map<string, MemberTunnel>()
	private nextId = 1

	constructor(private readonly logger: Logger) {}

	register(memberId: string, send: (data: string | Uint8Array) => void): void {
		// A re-register (reconnect) supersedes the old socket's streams.
		this.members.set(memberId, { send, streams: new Map(), wsStreams: new Map() })
		this.logger.info({ memberId }, 'preview tunnel registered')
	}

	unregister(memberId: string): void {
		const tunnel = this.members.get(memberId)
		if (!tunnel) return
		for (const s of tunnel.streams.values()) s.onError('tunnel closed')
		for (const ws of tunnel.wsStreams.values()) ws.close(1011, 'tunnel closed')
		this.members.delete(memberId)
		this.logger.info({ memberId }, 'preview tunnel unregistered')
	}

	hasMember(memberId: string): boolean {
		return this.members.has(memberId)
	}

	/** Route a JSON control frame from a Member back to its stream / WS bridge. */
	handleMemberFrame(memberId: string, frame: MemberToHouseholdTunnel): void {
		if (frame.t === 'hello') return
		const tunnel = this.members.get(memberId)
		if (!tunnel) return
		switch (frame.t) {
			case 'res.head':
				tunnel.streams
					.get(frame.id)
					?.onHead(frame.status, frame.headers, frame.setCookies ?? [])
				break
			case 'res.end':
				tunnel.streams.get(frame.id)?.onEnd()
				break
			case 'res.error':
				tunnel.streams.get(frame.id)?.onError(frame.message)
				break
			case 'ws.close':
				tunnel.wsStreams.get(frame.id)?.close(frame.code, frame.reason)
				tunnel.wsStreams.delete(frame.id)
				break
			case 'ws.error':
				tunnel.wsStreams.get(frame.id)?.close(1011, frame.message.slice(0, 120))
				tunnel.wsStreams.delete(frame.id)
				break
		}
	}

	/** Route a binary data frame (response body / bridged WS message) from a Member. */
	handleMemberData(memberId: string, buf: Uint8Array): void {
		const tunnel = this.members.get(memberId)
		if (!tunnel) return
		const frame = decodeDataFrame(buf)
		if (!frame) return
		if (frame.kind === DATA_RES) {
			// Copy out of the receive buffer — the bytes outlive this call in the stream.
			tunnel.streams.get(frame.id)?.onData(new Uint8Array(frame.payload))
		} else if (frame.kind === DATA_WS) {
			const ws = tunnel.wsStreams.get(frame.id)
			if (!ws) return
			if (frame.binary) ws.sendBinary(new Uint8Array(frame.payload))
			else ws.sendText(new TextDecoder().decode(frame.payload))
		}
	}

	// ─── WebSocket bridge (HMR) ─────────────────────────────────────────────

	/**
	 * Open a bridged preview WebSocket: register the browser side and ask the
	 * Member to dial its local dev-server socket. Returns the stream id, or null
	 * if the member's tunnel is gone (caller should close the browser socket).
	 */
	openWsStream(
		memberId: string,
		browser: WsStream,
		opts: { port: number; path: string; headers: Record<string, string>; protocols: string[] },
	): string | null {
		const tunnel = this.members.get(memberId)
		if (!tunnel) return null
		const id = `w${this.nextId++}`
		tunnel.wsStreams.set(id, browser)
		tunnel.send(
			encodeTunnel({
				t: 'ws.open',
				id,
				port: opts.port,
				path: opts.path,
				headers: opts.headers,
				...(opts.protocols.length > 0 ? { protocols: opts.protocols } : {}),
			}),
		)
		return id
	}

	/** Forward a browser → dev-server WebSocket message over the tunnel. */
	wsFromBrowser(memberId: string, id: string, data: string | ArrayBuffer | Uint8Array): void {
		const tunnel = this.members.get(memberId)
		if (!tunnel) return
		const binary = typeof data !== 'string'
		const payload =
			typeof data === 'string'
				? new TextEncoder().encode(data)
				: new Uint8Array(data instanceof ArrayBuffer ? data : data)
		tunnel.send(encodeDataFrame(DATA_WS, id, payload, binary))
	}

	/** The browser closed its side — tell the Member and drop the bridge. */
	closeWsFromBrowser(memberId: string, id: string, code?: number, reason?: string): void {
		const tunnel = this.members.get(memberId)
		if (!tunnel) return
		tunnel.wsStreams.delete(id)
		tunnel.send(
			encodeTunnel({
				t: 'ws.close',
				id,
				...(code ? { code } : {}),
				...(reason ? { reason } : {}),
			}),
		)
	}

	/**
	 * Proxy one HTTP request to `memberId`'s preview server on `port`. Resolves
	 * to a streaming `Response` once the Member sends `res.head` (or an error /
	 * timeout response). The body streams as binary data frames arrive.
	 */
	async proxy(
		memberId: string,
		req: {
			method: string
			path: string
			headers: Record<string, string>
			port: number
			body: ReadableStream<Uint8Array> | null
		},
	): Promise<Response> {
		const tunnel = this.members.get(memberId)
		if (!tunnel) return new Response('Preview member offline.', { status: 503 })

		const id = String(this.nextId++)
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null
		// Flow control: when the browser-side stream backs up past the high-water
		// mark we tell the Member to pause its dev-server read; we resume on
		// `pull` (consumer drained below the mark). Bounded memory, no base64.
		let paused = false
		const resume = () => {
			if (!paused) return
			paused = false
			tunnel.send(encodeTunnel({ t: 'res.resume', id }))
		}
		const stream = new ReadableStream<Uint8Array>(
			{
				start: (c) => {
					controller = c
				},
				pull: () => resume(),
				cancel: () => {
					tunnel.streams.delete(id)
					tunnel.send(encodeTunnel({ t: 'req.abort', id }))
				},
			},
			new ByteLengthQueuingStrategy({ highWaterMark: 256 * 1024 }),
		)

		return new Promise<Response>((resolve) => {
			let resolved = false
			const timer = setTimeout(() => {
				if (resolved) return
				resolved = true
				tunnel.streams.delete(id)
				tunnel.send(encodeTunnel({ t: 'req.abort', id }))
				resolve(new Response('Preview timed out.', { status: 504 }))
			}, HEAD_TIMEOUT_MS)
			timer.unref()

			tunnel.streams.set(id, {
				onHead: (status, headers, setCookies) => {
					if (resolved) return
					resolved = true
					clearTimeout(timer)
					resolve(
						new Response(stream, {
							status,
							headers: buildResponseHeaders(headers, setCookies),
						}),
					)
				},
				onData: (bytes) => {
					try {
						controller?.enqueue(bytes)
						if (!paused && controller && (controller.desiredSize ?? 1) <= 0) {
							paused = true
							tunnel.send(encodeTunnel({ t: 'res.pause', id }))
						}
					} catch {
						/* stream already closed/cancelled */
					}
				},
				onEnd: () => {
					try {
						controller?.close()
					} catch {
						/* already closed */
					}
					tunnel.streams.delete(id)
				},
				onError: (message) => {
					tunnel.streams.delete(id)
					if (!resolved) {
						resolved = true
						clearTimeout(timer)
						resolve(new Response(`Preview error: ${message}`, { status: 502 }))
						return
					}
					try {
						controller?.error(new Error(message))
					} catch {
						/* already settled */
					}
				},
			})

			tunnel.send(
				encodeTunnel({
					t: 'req.head',
					id,
					method: req.method,
					path: req.path,
					headers: req.headers,
					port: req.port,
				}),
			)
			if (req.body) {
				// Stream the request body chunk-by-chunk so a large upload isn't
				// buffered whole in the Household.
				void (async () => {
					const reader = req.body!.getReader()
					try {
						for (;;) {
							const { done, value } = await reader.read()
							if (done) break
							if (value && value.length > 0) {
								tunnel.send(encodeDataFrame(DATA_REQ, id, value))
							}
						}
					} catch {
						/* client aborted mid-upload */
					}
					tunnel.send(encodeTunnel({ t: 'req.end', id }))
				})()
			} else {
				tunnel.send(encodeTunnel({ t: 'req.end', id }))
			}
		})
	}
}

// ─── /ws/preview handler ────────────────────────────────────────────────────

export interface PreviewTunnelWsDeps {
	hub: PreviewTunnelHub
	tokens: TokenStore
	logger: Logger
}

export function createPreviewTunnelHandler(deps: PreviewTunnelWsDeps) {
	return (c: { req: { header: (name: string) => string | undefined } }) => {
		const authHeader = c.req.header('authorization') ?? ''
		const token = authHeader.toLowerCase().startsWith('bearer ')
			? authHeader.slice('bearer '.length).trim()
			: ''
		const valid = token ? deps.tokens.validate(token) : null
		let memberId: string | null = null

		return {
			onOpen: (_evt: unknown, ws: WSContext<unknown>) => {
				if (!valid) ws.close(4401, 'invalid_token')
			},
			onMessage: (evt: { data: unknown }, ws: WSContext<unknown>) => {
				if (!valid) return
				const data = evt.data
				// Binary data frames (bodies / bridged WS messages).
				if (typeof data !== 'string') {
					if (!memberId) return
					const bytes =
						data instanceof ArrayBuffer
							? new Uint8Array(data)
							: new Uint8Array(data as unknown as Uint8Array)
					deps.hub.handleMemberData(memberId, bytes)
					return
				}
				const frame = decodeTunnel<MemberToHouseholdTunnel>(data)
				if (!frame) return
				if (frame.t === 'hello') {
					memberId = frame.member_id
					deps.hub.register(memberId, (out) =>
						ws.send(typeof out === 'string' ? out : new Uint8Array(out)),
					)
					return
				}
				if (memberId) deps.hub.handleMemberFrame(memberId, frame)
			},
			onClose: () => {
				if (memberId) deps.hub.unregister(memberId)
			},
			onError: () => {
				if (memberId) deps.hub.unregister(memberId)
			},
		}
	}
}

// ─── Host middleware ────────────────────────────────────────────────────────

export interface PreviewHostDeps {
	hub: PreviewTunnelHub
	taskStore: TaskStore
	previewsDomain: string
	logger: Logger
}

/**
 * Intercept requests on a preview subdomain and proxy them over the owning
 * Member's tunnel. Passes everything else through untouched.
 */
export function previewHostMiddleware(deps: PreviewHostDeps): MiddlewareHandler {
	return async (c: Context, next) => {
		const host = c.req.header('host') ?? ''
		const parsed = parsePreviewHost(host, deps.previewsDomain)
		if (!parsed) return next()
		// WebSocket upgrades (HMR) are handled by the upgrade route, not here —
		// let them fall through.
		if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return next()

		const task = deps.taskStore.get(parsed.taskId)
		if (!task) return c.text('No such preview.', 404)
		if (!ACTIVE_STATUSES.has(task.status)) return c.text('This preview has ended.', 410)
		if (!previewPortsOf(task).some((p) => p.port === parsed.port)) {
			return c.text('No such preview port.', 404)
		}
		const memberId = task.assignedMemberId
		if (!memberId || !deps.hub.hasMember(memberId)) {
			return c.text('Preview server not connected.', 503)
		}

		const method = c.req.method
		const body = method === 'GET' || method === 'HEAD' ? null : c.req.raw.body
		const url = new URL(c.req.url)
		return deps.hub.proxy(memberId, {
			method,
			path: url.pathname + url.search,
			headers: headerRecord(c.req.raw.headers),
			port: parsed.port,
			body,
		})
	}
}

/**
 * Browser-facing WebSocket upgrade handler (HMR). Registered as a catch-all
 * `app.get('*', upgradeWebSocket(...))`: for a preview-subdomain upgrade it
 * bridges the browser socket to the Member's local dev-server socket over the
 * tunnel; anything else (or a non-preview host) is closed immediately.
 *
 * Subprotocols negotiate on both hops: the WS server echoes the first the
 * browser offers (see `handleProtocols` in `index.ts`), and the offered list is
 * forwarded here to the Member's local connection — so Vite's `vite-hmr` is
 * selected end-to-end. Webpack/Next HMR (no subprotocol) is unaffected.
 */
export function createPreviewWsTunnelHandler(deps: PreviewHostDeps) {
	return (c: Context) => {
		const parsed = parsePreviewHost(c.req.header('host') ?? '', deps.previewsDomain)
		let target: { memberId: string; port: number; path: string } | null = null
		if (parsed) {
			const task = deps.taskStore.get(parsed.taskId)
			const memberId = task?.assignedMemberId ?? null
			if (
				task &&
				ACTIVE_STATUSES.has(task.status) &&
				previewPortsOf(task).some((p) => p.port === parsed.port) &&
				memberId &&
				deps.hub.hasMember(memberId)
			) {
				const url = new URL(c.req.url)
				target = { memberId, port: parsed.port, path: url.pathname + url.search }
			}
		}
		const headers = headerRecord(c.req.raw.headers)
		const protocols = (c.req.header('sec-websocket-protocol') ?? '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)

		let streamId: string | null = null
		return {
			onOpen: (_evt: unknown, ws: WSContext<unknown>) => {
				if (!target) {
					ws.close(1011, 'no such preview')
					return
				}
				streamId = deps.hub.openWsStream(
					target.memberId,
					{
						sendText: (text) => ws.send(text),
						sendBinary: (bytes) => ws.send(new Uint8Array(bytes)),
						close: (code, reason) => ws.close(code, reason),
					},
					{ port: target.port, path: target.path, headers, protocols },
				)
				if (!streamId) ws.close(1011, 'preview offline')
			},
			onMessage: (evt: { data: string | ArrayBuffer | Uint8Array }) => {
				if (target && streamId) deps.hub.wsFromBrowser(target.memberId, streamId, evt.data)
			},
			onClose: (evt: { code?: number; reason?: string }) => {
				if (target && streamId)
					deps.hub.closeWsFromBrowser(target.memberId, streamId, evt.code, evt.reason)
			},
			onError: () => {
				if (target && streamId)
					deps.hub.closeWsFromBrowser(target.memberId, streamId, 1011, 'error')
			},
		}
	}
}

function headerRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {}
	headers.forEach((value, key) => {
		out[key] = value
	})
	return out
}

/**
 * Build the response `Headers`, dropping hop-by-hop headers the node server
 * frames itself and appending each `set-cookie` separately (so several cookies
 * survive as distinct headers rather than a broken comma-joined one).
 */
function buildResponseHeaders(headers: Record<string, string>, setCookies: string[]): Headers {
	const out = new Headers()
	for (const [k, v] of Object.entries(headers)) {
		const lower = k.toLowerCase()
		if (
			lower === 'connection' ||
			lower === 'transfer-encoding' ||
			lower === 'keep-alive' ||
			lower === 'set-cookie'
		) {
			continue
		}
		out.set(k, v)
	}
	for (const cookie of setCookies) out.append('set-cookie', cookie)
	return out
}
