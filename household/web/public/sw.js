// Minimal service worker. The app is live (WebSocket-driven), so the SW does
// not pretend to work offline — it only:
//   1. Caches the navigation shell (index.html) for fast cold loads.
//   2. Stale-while-revalidates same-origin static assets (Vite-hashed JS/CSS).
//   3. NEVER intercepts /api/, /auth/, /ws/, /webhooks/, or /health — those
//      must always hit the network so cookies / SSE / WebSockets behave
//      correctly.
// Bump CACHE_NAME on shape changes to evict old entries.

const CACHE_NAME = 'night-shell-v1'
const SHELL_URL = '/'

self.addEventListener('install', (event) => {
	// Auto-activate on a fresh install (no existing controller). On *updates*
	// we wait for an explicit `SKIP_WAITING` message from the page so the user
	// can be prompted to reload via the in-app toast.
	if (!self.registration.active) {
		self.skipWaiting()
	}
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => cache.add(SHELL_URL).catch(() => undefined)),
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
			)
			.then(() => self.clients.claim()),
	)
})

self.addEventListener('message', (event) => {
	if (event.data && event.data.type === 'SKIP_WAITING') {
		self.skipWaiting()
	}
})

function isPassthrough(url) {
	return (
		url.pathname.startsWith('/api/') ||
		url.pathname.startsWith('/auth/') ||
		url.pathname.startsWith('/ws/') ||
		url.pathname.startsWith('/webhooks/') ||
		url.pathname === '/health'
	)
}

self.addEventListener('fetch', (event) => {
	const req = event.request
	if (req.method !== 'GET') return
	const url = new URL(req.url)
	if (url.origin !== self.location.origin) return
	if (isPassthrough(url)) return

	if (req.mode === 'navigate') {
		event.respondWith(
			fetch(req)
				.then((res) => {
					const copy = res.clone()
					caches.open(CACHE_NAME).then((c) => c.put(SHELL_URL, copy))
					return res
				})
				.catch(() => caches.match(SHELL_URL).then((r) => r || Response.error())),
		)
		return
	}

	event.respondWith(
		caches.open(CACHE_NAME).then(async (cache) => {
			const cached = await cache.match(req)
			const network = fetch(req)
				.then((res) => {
					if (res && res.ok) cache.put(req, res.clone()).catch(() => undefined)
					return res
				})
				.catch(() => cached)
			return cached || network
		}),
	)
})
