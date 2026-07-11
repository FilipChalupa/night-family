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
import type { MemberRegistry } from '../members/registry.ts'
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

/**
 * Once the response is streaming, how long to wait between body frames before
 * giving up. Closes the gap where a Member stays connected but its dev server
 * stalls mid-response (or the tunnel quietly stops delivering): without this
 * the browser would hang until its own timeout.
 */
const BODY_IDLE_TIMEOUT_MS = 60_000

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
		// A re-register (reconnect) supersedes the old socket. Fail its in-flight
		// streams fast instead of leaving them to hang until the head/body idle
		// timeouts — the old socket can no longer deliver their responses.
		this.teardownStreams(memberId, 'tunnel superseded')
		this.members.set(memberId, { send, streams: new Map(), wsStreams: new Map() })
		this.logger.info({ memberId }, 'preview tunnel registered')
	}

	unregister(memberId: string): void {
		if (this.teardownStreams(memberId, 'tunnel closed')) {
			this.members.delete(memberId)
			this.logger.info({ memberId }, 'preview tunnel unregistered')
		}
	}

	/** Error out a member's in-flight HTTP/WS streams. Returns false if unknown. */
	private teardownStreams(memberId: string, reason: string): boolean {
		const tunnel = this.members.get(memberId)
		if (!tunnel) return false
		for (const s of tunnel.streams.values()) s.onError(reason)
		for (const ws of tunnel.wsStreams.values()) ws.close(1011, reason)
		return true
	}

	hasMember(memberId: string): boolean {
		return this.members.has(memberId)
	}

	/** How many Members currently have a live preview tunnel. */
	connectedCount(): number {
		return this.members.size
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

			// Idle watchdog for the streaming body — reset on every frame, fires
			// if the Member goes quiet mid-response without an end/error.
			let bodyTimer: NodeJS.Timeout | null = null
			const clearBodyTimer = () => {
				if (bodyTimer) clearTimeout(bodyTimer)
				bodyTimer = null
			}
			const armBodyTimer = () => {
				clearBodyTimer()
				bodyTimer = setTimeout(() => {
					tunnel.streams.delete(id)
					tunnel.send(encodeTunnel({ t: 'req.abort', id }))
					try {
						controller?.error(new Error('preview stalled mid-response'))
					} catch {
						/* already settled */
					}
				}, BODY_IDLE_TIMEOUT_MS)
				bodyTimer.unref()
			}

			tunnel.streams.set(id, {
				onHead: (status, headers, setCookies) => {
					if (resolved) return
					resolved = true
					clearTimeout(timer)
					armBodyTimer()
					resolve(
						new Response(stream, {
							status,
							headers: buildResponseHeaders(headers, setCookies),
						}),
					)
				},
				onData: (bytes) => {
					armBodyTimer()
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
					clearBodyTimer()
					try {
						controller?.close()
					} catch {
						/* already closed */
					}
					tunnel.streams.delete(id)
				},
				onError: (message) => {
					clearBodyTimer()
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
	registry: MemberRegistry
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
					// Derive the member from a live control-plane session — never
					// trust a self-asserted id, so a token holder can't register as
					// (and hijack the traffic of) a different member.
					const member = deps.registry.get(frame.session_id)
					if (!member) {
						deps.logger.warn('preview tunnel hello with unknown session — closing')
						ws.close(4401, 'invalid_session')
						return
					}
					memberId = member.memberId
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

// ─── Idle tracking ──────────────────────────────────────────────────────────

/**
 * Last-seen traffic per preview task, so the Household can tear down previews
 * nobody is looking at. Touched by the host middleware (HTTP) and the WS
 * upgrade handler (HMR pings keep an open preview alive).
 */
export class PreviewActivity {
	private readonly last = new Map<string, number>()
	touch(taskId: string, now: number = Date.now()): void {
		this.last.set(taskId, now)
	}
	lastAt(taskId: string): number | undefined {
		return this.last.get(taskId)
	}
	forget(taskId: string): void {
		this.last.delete(taskId)
	}
	/** Drop entries for tasks no longer in `keep` (keeps the map bounded). */
	retain(keep: ReadonlySet<string>): void {
		for (const id of this.last.keys()) if (!keep.has(id)) this.last.delete(id)
	}
}

/**
 * Of the given tasks, the `preview` ones idle longer than `ttlMs`. Falls back to
 * `updatedAt` (≈ when the preview last became ready) when no traffic has been
 * recorded yet, so a preview nobody ever opened still ages out.
 */
export function idlePreviewTaskIds(
	tasks: ReadonlyArray<{ id: string; kind: string; updatedAt: string }>,
	activity: PreviewActivity,
	ttlMs: number,
	now: number = Date.now(),
): string[] {
	const out: string[] = []
	for (const t of tasks) {
		if (t.kind !== 'preview') continue
		const last = activity.lastAt(t.id) ?? new Date(t.updatedAt).getTime()
		if (now - last >= ttlMs) out.push(t.id)
	}
	return out
}

// ─── Host middleware ────────────────────────────────────────────────────────

export interface PreviewHostDeps {
	hub: PreviewTunnelHub
	taskStore: TaskStore
	previewsDomain: string
	activity: PreviewActivity
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
		deps.activity.touch(parsed.taskId)

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
				if (parsed) deps.activity.touch(parsed.taskId)
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
				if (parsed) deps.activity.touch(parsed.taskId)
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
