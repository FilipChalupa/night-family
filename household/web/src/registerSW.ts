/**
 * PWA service worker plumbing. Two responsibilities:
 *   1. Register `/sw.js` (production builds only — in dev a stale SW would
 *      mask Vite module reloads).
 *   2. Surface "a new version is waiting" to the React app via
 *      `onServiceWorkerUpdate`, so the layout can show a Reload toast.
 *
 * Update flow:
 *   - On `updatefound`, we get a new installing worker.
 *   - When that worker reaches `installed` AND there's an existing controller
 *     (so this is an update, not a first install), we notify listeners.
 *   - The toast hands the user a `reload` callback. Clicking it posts
 *     `SKIP_WAITING` to the new worker, the SW activates, browser fires
 *     `controllerchange`, and we hard-reload the page so the new chunks load.
 */

type UpdateListener = (reload: () => void) => void

const updateListeners = new Set<UpdateListener>()

export function onServiceWorkerUpdate(cb: UpdateListener): () => void {
	updateListeners.add(cb)
	return () => {
		updateListeners.delete(cb)
	}
}

let reloadingFromUpdate = false

function dispatchUpdate(reg: ServiceWorkerRegistration): void {
	const reload = () => {
		reloadingFromUpdate = true
		reg.waiting?.postMessage({ type: 'SKIP_WAITING' })
	}
	for (const l of updateListeners) l(reload)
}

export function registerServiceWorker(): void {
	if (!import.meta.env.PROD) return
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

	navigator.serviceWorker.addEventListener('controllerchange', () => {
		// First-install activations also fire this. Reloading then would be
		// jarring, so we only act on user-initiated SKIP_WAITING (the flag is
		// set in `dispatchUpdate`'s reload callback).
		if (!reloadingFromUpdate) return
		window.location.reload()
	})

	window.addEventListener('load', () => {
		navigator.serviceWorker
			.register('/sw.js')
			.then((reg) => {
				// A previous tab may have already installed an update that's now
				// sitting in `waiting`. Notify immediately if so.
				if (reg.waiting && navigator.serviceWorker.controller) {
					dispatchUpdate(reg)
				}

				reg.addEventListener('updatefound', () => {
					const installing = reg.installing
					if (!installing) return
					installing.addEventListener('statechange', () => {
						if (
							installing.state === 'installed' &&
							navigator.serviceWorker.controller
						) {
							dispatchUpdate(reg)
						}
					})
				})
			})
			.catch(() => {
				// Best-effort. App still works without SW.
			})
	})
}
