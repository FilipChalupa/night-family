/**
 * SSRF guard for outbound webhook POSTs.
 *
 * Notification channel URLs are admin-supplied, so without a check the server
 * can be pointed at internal services: cloud metadata (169.254.169.254),
 * localhost admin panels, RFC 1918 hosts, etc. `assertPublicUrl` rejects any
 * URL that resolves to a non-public address. Defense-in-depth — it complements,
 * not replaces, the admin auth on the notification-channel endpoints.
 *
 * Residual: a DNS-rebinding attacker could return a public IP to our lookup and
 * a private one to fetch's own connect. Pinning the resolved IP into the
 * request would close that; the common threat here (an admin/misconfig pointing
 * at an internal host) is fully covered.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class SsrfError extends Error {}

/** Throws {@link SsrfError} unless every resolved address of `rawUrl` is public. */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		throw new SsrfError(`invalid URL: ${rawUrl}`)
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new SsrfError(`unsupported scheme: ${url.protocol}`)
	}
	const host = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets
	const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
	if (ips.length === 0) throw new SsrfError(`could not resolve ${host}`)
	for (const ip of ips) {
		if (!isPublicIp(ip)) {
			throw new SsrfError(`refusing to POST to non-public address ${ip} (${host})`)
		}
	}
}

/** True only for a routable, non-private/loopback/link-local unicast address. */
export function isPublicIp(ip: string): boolean {
	const kind = isIP(ip)
	if (kind === 4) return !isPrivateV4(ip)
	if (kind === 6) return !isPrivateV6(ip)
	return false // unparseable → not public
}

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split('.')
	if (parts.length !== 4) return null
	let n = 0
	for (const p of parts) {
		if (!/^\d+$/.test(p)) return null
		const o = Number(p)
		if (o > 255) return null
		n = (n << 8) | o
	}
	return n >>> 0
}

function isPrivateV4(ip: string): boolean {
	const n = ipv4ToInt(ip)
	if (n === null) return true // unparseable → treat as unsafe
	const inRange = (base: string, bits: number): boolean => {
		const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
		return (n & mask) === (ipv4ToInt(base)! & mask)
	}
	return (
		inRange('0.0.0.0', 8) || // "this network"
		inRange('10.0.0.0', 8) || // private
		inRange('100.64.0.0', 10) || // CGNAT
		inRange('127.0.0.0', 8) || // loopback
		inRange('169.254.0.0', 16) || // link-local (incl. 169.254.169.254 metadata)
		inRange('172.16.0.0', 12) || // private
		inRange('192.0.0.0', 24) || // IETF protocol assignments
		inRange('192.168.0.0', 16) || // private
		inRange('198.18.0.0', 15) || // benchmarking
		inRange('240.0.0.0', 4) // reserved / broadcast
	)
}

function isPrivateV6(ip: string): boolean {
	const lower = (ip.split('%')[0] ?? '').toLowerCase() // strip zone id
	if (lower === '::1' || lower === '::') return true // loopback / unspecified
	// IPv4-mapped (::ffff:a.b.c.d) or -compatible (::a.b.c.d) → check the v4.
	const v4 = lower.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/)
	if (v4) return isPrivateV4(v4[1]!)
	const first = lower.split(':')[0] ?? ''
	if (/^f[cd]/.test(first)) return true // unique-local fc00::/7
	if (/^fe[89ab]/.test(first)) return true // link-local fe80::/10
	return false
}
