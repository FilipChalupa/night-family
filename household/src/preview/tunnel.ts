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
 * surface). v1 proxies plain HTTP; WebSocket upgrades (HMR) come later.
 */

import type { Context, MiddlewareHandler } from 'hono'
import type { WSContext } from 'hono/ws'
import {
	decodeTunnel,
	encodeTunnel,
	parsePreviewHost,
	type MemberToHouseholdTunnel,
	type TunnelFrame,
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
	onHead: (status: number, headers: Record<string, string>) => void
	onData: (bytes: Uint8Array) => void
	onEnd: () => void
	onError: (message: string) => void
}

interface MemberTunnel {
	send: (frame: TunnelFrame) => void
	streams: Map<string, StreamHandlers>
}

/**
 * Tracks the live `/ws/preview` sockets (one per Member) and multiplexes
 * inbound HTTP requests over them.
 */
export class PreviewTunnelHub {
	private readonly members = new Map<string, MemberTunnel>()
	private nextId = 1

	constructor(private readonly logger: Logger) {}

	register(memberId: string, send: (frame: TunnelFrame) => void): void {
		// A re-register (reconnect) supersedes the old socket's streams.
		this.members.set(memberId, { send, streams: new Map() })
		this.logger.info({ memberId }, 'preview tunnel registered')
	}

	unregister(memberId: string): void {
		const tunnel = this.members.get(memberId)
		if (!tunnel) return
		for (const s of tunnel.streams.values()) s.onError('tunnel closed')
		this.members.delete(memberId)
		this.logger.info({ memberId }, 'preview tunnel unregistered')
	}

	hasMember(memberId: string): boolean {
		return this.members.has(memberId)
	}

	/** Route a `res.*` frame from a Member back to its waiting stream. */
	handleResFrame(memberId: string, frame: MemberToHouseholdTunnel): void {
		if (frame.t === 'hello') return
		const tunnel = this.members.get(memberId)
		const handlers = tunnel?.streams.get(frame.id)
		if (!handlers) return
		switch (frame.t) {
			case 'res.head':
				handlers.onHead(frame.status, frame.headers)
				break
			case 'res.data':
				handlers.onData(new Uint8Array(Buffer.from(frame.b64, 'base64')))
				break
			case 'res.end':
				handlers.onEnd()
				break
			case 'res.error':
				handlers.onError(frame.message)
				break
		}
	}

	/**
	 * Proxy one HTTP request to `memberId`'s preview server on `port`. Resolves
	 * to a streaming `Response` once the Member sends `res.head` (or an error /
	 * timeout response). The body streams as `res.data` frames arrive.
	 */
	async proxy(
		memberId: string,
		req: {
			method: string
			path: string
			headers: Record<string, string>
			port: number
			bodyBytes: Uint8Array | null
		},
	): Promise<Response> {
		const tunnel = this.members.get(memberId)
		if (!tunnel) return new Response('Preview member offline.', { status: 503 })

		const id = String(this.nextId++)
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null
		const stream = new ReadableStream<Uint8Array>({
			start: (c) => {
				controller = c
			},
			cancel: () => {
				tunnel.streams.delete(id)
				tunnel.send({ t: 'req.abort', id })
			},
		})

		return new Promise<Response>((resolve) => {
			let resolved = false
			const timer = setTimeout(() => {
				if (resolved) return
				resolved = true
				tunnel.streams.delete(id)
				tunnel.send({ t: 'req.abort', id })
				resolve(new Response('Preview timed out.', { status: 504 }))
			}, HEAD_TIMEOUT_MS)
			timer.unref()

			tunnel.streams.set(id, {
				onHead: (status, headers) => {
					if (resolved) return
					resolved = true
					clearTimeout(timer)
					resolve(
						new Response(stream, { status, headers: sanitizeResponseHeaders(headers) }),
					)
				},
				onData: (bytes) => {
					try {
						controller?.enqueue(bytes)
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

			tunnel.send({
				t: 'req.head',
				id,
				method: req.method,
				path: req.path,
				headers: req.headers,
				port: req.port,
			})
			if (req.bodyBytes && req.bodyBytes.length > 0) {
				tunnel.send({
					t: 'req.data',
					id,
					b64: Buffer.from(req.bodyBytes).toString('base64'),
				})
			}
			tunnel.send({ t: 'req.end', id })
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
				const frame = decodeTunnel<MemberToHouseholdTunnel>(String(evt.data))
				if (!frame) return
				if (frame.t === 'hello') {
					memberId = frame.member_id
					deps.hub.register(memberId, (f) => ws.send(encodeTunnel(f)))
					return
				}
				if (memberId) deps.hub.handleResFrame(memberId, frame)
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
		const bodyBytes =
			method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await c.req.arrayBuffer())
		const url = new URL(c.req.url)
		return deps.hub.proxy(memberId, {
			method,
			path: url.pathname + url.search,
			headers: headerRecord(c.req.raw.headers),
			port: parsed.port,
			bodyBytes,
		})
	}
}

function headerRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {}
	headers.forEach((value, key) => {
		out[key] = value
	})
	return out
}

/** Drop hop-by-hop headers the node server frames itself. */
function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(headers)) {
		const lower = k.toLowerCase()
		if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive')
			continue
		out[k] = v
	}
	return out
}
