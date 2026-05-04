/**
 * Register the PWA service worker. Only runs in production builds — in dev,
 * Vite owns module loading and a stale SW would mask code changes.
 *
 * The SW itself lives at `public/sw.js` (served from the site root) and is
 * intentionally minimal: it caches the app shell and Vite-hashed assets but
 * never intercepts /api/, /auth/, /ws/, /webhooks/, /health.
 */
export function registerServiceWorker(): void {
	if (!import.meta.env.PROD) return
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
	window.addEventListener('load', () => {
		navigator.serviceWorker.register('/sw.js').catch(() => {
			// Best-effort. If registration fails the app still works as a plain SPA.
		})
	})
}
