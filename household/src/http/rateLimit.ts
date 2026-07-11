/**
 * Minimal in-memory fixed-window rate limiter for public endpoints.
 *
 * Bounds abuse of the unauthenticated surface — webhook floods (each one costs
 * an HMAC verify + a DB write) and brute-forcing of the OAuth callback state —
 * without a dependency. Per-process only; behind multiple replicas each has its
 * own window, which is fine for a coarse safety cap.
 */

import type { Context, MiddlewareHandler } from 'hono'

interface Bucket {
	count: number
	resetAt: number
}

/** Best-effort client IP: first x-forwarded-for hop, else the socket address. */
export function clientIp(c: Context): string {
	const xff = c.req.header('x-forwarded-for')
	if (xff) {
		const first = xff.split(',')[0]?.trim()
		if (first) return first
	}
	const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
	return env?.incoming?.socket?.remoteAddress ?? 'unknown'
}

export function rateLimit(opts: {
	windowMs: number
	max: number
	now?: () => number
	key?: (c: Context) => string
}): MiddlewareHandler {
	const now = opts.now ?? (() => Date.now())
	const keyOf = opts.key ?? clientIp
	const buckets = new Map<string, Bucket>()

	return async (c, next) => {
		const t = now()
		const key = keyOf(c)
		const bucket = buckets.get(key)
		if (!bucket || t >= bucket.resetAt) {
			buckets.set(key, { count: 1, resetAt: t + opts.windowMs })
		} else {
			bucket.count += 1
			if (bucket.count > opts.max) {
				const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000))
				c.header('Retry-After', String(retryAfter))
				return c.json({ error: 'rate_limited' }, 429)
			}
		}
		// Opportunistic cleanup so the map can't grow unbounded from unique IPs.
		if (buckets.size > 10_000) {
			for (const [k, b] of buckets) if (t >= b.resetAt) buckets.delete(k)
		}
		await next()
	}
}
