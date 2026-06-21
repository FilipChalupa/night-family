/**
 * Preview tunnel — frame protocol for proxying preview traffic from the
 * Household to a Member over a dedicated `/ws/preview` WebSocket the Member
 * opens (so NAT'd Members stay reachable: only the Household is ever inbound).
 *
 * Two kinds of WebSocket message ride this socket:
 *   - **Control frames** are text (JSON) — `req.head`, `res.head`, `ws.open`,
 *     flow control (`res.pause`/`res.resume`), etc. See {@link TunnelFrame}.
 *   - **Data frames** are binary — request bodies, response bodies and bridged
 *     WebSocket messages — framed by {@link encodeDataFrame} with a tiny header
 *     (no base64; bytes go on the wire as-is).
 *
 * It rides its own socket, NOT the control-plane `/ws/member` connection, so it
 * doesn't touch the versioned wire protocol or the event log. One inbound
 * request/WS = one `id` (stream).
 */

// ─── Household → Member (the inbound request) ───────────────────────────────

export interface TunnelReqHead {
	t: 'req.head'
	id: string
	method: string
	/** Path + query, origin-relative (e.g. `/assets/app.js?v=1`). */
	path: string
	headers: Record<string, string>
	/** Member-local port to proxy to (`localhost:<port>`). */
	port: number
}
export interface TunnelReqEnd {
	t: 'req.end'
	id: string
}
export interface TunnelReqAbort {
	t: 'req.abort'
	id: string
}

// WebSocket upgrades (HMR). The browser↔Household socket is bridged to a
// Member-local WebSocket. Messages flow as binary data frames; open/close as
// control frames.
export interface TunnelWsOpen {
	t: 'ws.open'
	id: string
	port: number
	/** Path + query the browser upgraded on. */
	path: string
	headers: Record<string, string>
	/** Subprotocols the browser offered (e.g. `vite-hmr`). */
	protocols?: string[]
}
export interface TunnelWsClose {
	t: 'ws.close'
	id: string
	code?: number
	reason?: string
}
export interface TunnelWsError {
	t: 'ws.error'
	id: string
	message: string
}

/** Flow control: Household asks the Member to pause/resume a response stream. */
export interface TunnelResPause {
	t: 'res.pause'
	id: string
}
export interface TunnelResResume {
	t: 'res.resume'
	id: string
}

export type HouseholdToMemberTunnel =
	| TunnelReqHead
	| TunnelReqEnd
	| TunnelReqAbort
	| TunnelWsOpen
	| TunnelWsClose
	| TunnelResPause
	| TunnelResResume

// ─── Member → Household (registration + the response) ───────────────────────

/** First frame the Member sends, claiming which member this socket serves. */
export interface TunnelHello {
	t: 'hello'
	member_id: string
}
export interface TunnelResHead {
	t: 'res.head'
	id: string
	status: number
	headers: Record<string, string>
	/**
	 * `set-cookie` values kept separate — a `Record` can't hold the several a
	 * response may set, and joining them with `, ` corrupts `Expires` dates.
	 */
	setCookies?: string[]
}
export interface TunnelResEnd {
	t: 'res.end'
	id: string
}
export interface TunnelResError {
	t: 'res.error'
	id: string
	message: string
}

export type MemberToHouseholdTunnel =
	| TunnelHello
	| TunnelResHead
	| TunnelResEnd
	| TunnelResError
	| TunnelWsClose
	| TunnelWsError

export type TunnelFrame = HouseholdToMemberTunnel | MemberToHouseholdTunnel

export function encodeTunnel(msg: TunnelFrame): string {
	return JSON.stringify(msg)
}

export function decodeTunnel<T = TunnelFrame>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T
	} catch {
		return null
	}
}

// ─── Binary data frames ─────────────────────────────────────────────────────
//
// Layout: [kind:u8][binary:u8][idLen:u8][id bytes…][payload bytes…]. `id`s are
// tiny ascii ("1", "w3"). `binary` only matters for `ws` messages (text vs
// binary); request/response bodies are always raw bytes.

export const DATA_REQ = 1
export const DATA_RES = 2
export const DATA_WS = 3

export interface DataFrame {
	kind: number
	id: string
	binary: boolean
	payload: Uint8Array
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encodeDataFrame(
	kind: number,
	id: string,
	payload: Uint8Array,
	binary = false,
): Uint8Array {
	const idBytes = textEncoder.encode(id)
	const out = new Uint8Array(3 + idBytes.length + payload.length)
	out[0] = kind
	out[1] = binary ? 1 : 0
	out[2] = idBytes.length
	out.set(idBytes, 3)
	out.set(payload, 3 + idBytes.length)
	return out
}

export function decodeDataFrame(buf: Uint8Array): DataFrame | null {
	if (buf.length < 3) return null
	const idLen = buf[2]!
	if (buf.length < 3 + idLen) return null
	return {
		kind: buf[0]!,
		binary: buf[1] === 1,
		id: textDecoder.decode(buf.subarray(3, 3 + idLen)),
		payload: buf.subarray(3 + idLen),
	}
}

// ─── Host ⇄ (task, port) mapping ────────────────────────────────────────────

export interface PreviewHost {
	taskId: string
	port: number
}

/**
 * Parse a preview Host header — `p<port>-<taskId>.<previewsDomain>` — into its
 * `(taskId, port)`. Returns null for any host that isn't a preview subdomain.
 * Tolerates a `:port` suffix on the Host and is case-insensitive. The task id
 * keeps its hyphens (UUID) since the port is delimited by the first `-`.
 */
export function parsePreviewHost(host: string, previewsDomain: string): PreviewHost | null {
	if (!host || !previewsDomain) return null
	const h = (host.split(':')[0] ?? '').toLowerCase()
	const suffix = '.' + previewsDomain.toLowerCase()
	if (!h.endsWith(suffix) || h.length <= suffix.length) return null
	const label = h.slice(0, -suffix.length)
	const m = /^p(\d+)-(.+)$/.exec(label)
	if (!m) return null
	const port = Number(m[1])
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null
	return { taskId: m[2]!, port }
}

/** Build the public subdomain URL for a `(task, port)` preview. */
export function buildPreviewSubdomainUrl(
	previewsDomain: string,
	taskId: string,
	port: number,
): string {
	return `https://p${port}-${taskId}.${previewsDomain}`
}
