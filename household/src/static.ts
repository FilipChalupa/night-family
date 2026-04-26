import type { Hono } from 'hono'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { Logger } from 'pino'
import type { AdminGuard } from './auth/guard.ts'

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.map': 'application/json; charset=utf-8',
}

function mimeFor(path: string): string {
	return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function safeJoin(root: string, requested: string): string | null {
	const clean = normalize(requested).replace(/^(\.\.[/\\])+/, '')
	const full = resolve(root, '.' + (clean.startsWith('/') ? clean : '/' + clean))
	const rel = relative(root, full)
	if (rel.startsWith('..') || resolve(root, rel) !== full) return null
	return full
}

/**
 * Mount the built web UI on `app`. Reserved API/ws/auth paths are skipped
 * (so they fall through to their own handlers). Anything else either serves
 * a file from the dist directory or, for SPA routes, returns index.html.
 */
export function mountStaticUi(
	app: Hono,
	candidates: string[],
	logger: Logger,
	guard: AdminGuard,
): void {
	const root = candidates.find((p) => existsSync(p))
	if (!root) {
		logger.warn(
			{ candidates },
			'web UI dist not found; run `npm run build --workspace @night/household-web`',
		)
		return
	}

	logger.info({ webDist: root }, 'serving web UI')
	const indexPath = join(root, 'index.html')

	app.get('*', async (c) => {
		const url = new URL(c.req.url)
		const reqPath = url.pathname

		if (
			reqPath.startsWith('/api/') ||
			reqPath.startsWith('/ws/') ||
			reqPath.startsWith('/auth/') ||
			reqPath === '/health' ||
			reqPath.startsWith('/webhooks/')
		) {
			return c.notFound()
		}

		const guardResult = guard.requireAuthenticatedPage(c)
		if (guardResult) return guardResult

		const candidate = reqPath === '/' ? indexPath : safeJoin(root, reqPath)
		if (candidate && existsSync(candidate) && statSync(candidate).isFile()) {
			const stream = Readable.toWeb(createReadStream(candidate)) as ReadableStream
			return new Response(stream, {
				headers: { 'content-type': mimeFor(candidate) },
			})
		}

		// SPA fallback — return index.html for any unknown route.
		if (existsSync(indexPath)) {
			const stream = Readable.toWeb(createReadStream(indexPath)) as ReadableStream
			return new Response(stream, {
				headers: { 'content-type': 'text/html; charset=utf-8' },
			})
		}

		return c.notFound()
	})
}
