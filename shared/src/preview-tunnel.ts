/**
 * Preview tunnel — frame protocol for proxying preview HTTP traffic from the
 * Household to a Member over a dedicated `/ws/preview` WebSocket the Member
 * opens (so NAT'd Members stay reachable: only the Household is ever inbound).
 *
 * This rides its own socket, NOT the control-plane `/ws/member` connection, so
 * it doesn't touch the versioned wire protocol or the event log. Bodies are
 * base64 in JSON frames — simple and correct; a binary framing optimisation can
 * come later if preview throughput ever warrants it.
 *
 * One inbound HTTP request = one `id` (stream). The Household drives `req.*`
 * frames downstream; the Member answers with `res.*` upstream. WebSocket
 * upgrades (HMR) are a later phase — v1 tunnels plain HTTP only.
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
export interface TunnelReqData {
	t: 'req.data'
	id: string
	/** base64 request-body chunk. */
	b64: string
}
export interface TunnelReqEnd {
	t: 'req.end'
	id: string
}
export interface TunnelReqAbort {
	t: 'req.abort'
	id: string
}

// WebSocket upgrades (HMR) — phase 2. The browser↔Household socket is bridged
// to a Member-local WebSocket. `ws.msg`/`ws.close` flow both directions.
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
export interface TunnelWsMsg {
	t: 'ws.msg'
	id: string
	b64: string
	/** true = binary frame, false = text. */
	binary: boolean
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

export type HouseholdToMemberTunnel =
	| TunnelReqHead
	| TunnelReqData
	| TunnelReqEnd
	| TunnelReqAbort
	| TunnelWsOpen
	| TunnelWsMsg
	| TunnelWsClose

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
}
export interface TunnelResData {
	t: 'res.data'
	id: string
	b64: string
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
	| TunnelResData
	| TunnelResEnd
	| TunnelResError
	| TunnelWsMsg
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
