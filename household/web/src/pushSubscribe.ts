/**
 * Browser-side Web Push subscription helper. Two responsibilities:
 *   1. Convert the household's VAPID public key (URL-safe base64) into the
 *      `Uint8Array` the PushManager expects.
 *   2. Subscribe / unsubscribe via the active service worker registration
 *      and POST/DELETE the subscription to the household.
 *
 * The hook layer (`NotificationsToggle`) calls these from a user gesture so
 * the browser actually grants `pushManager.subscribe`.
 */

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
	const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
	const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
	const raw = atob(base64)
	// Allocate against an ArrayBuffer (not the default ArrayBufferLike) so the
	// result satisfies BufferSource on stricter lib.dom.d.ts versions.
	const buffer = new ArrayBuffer(raw.length)
	const out = new Uint8Array(buffer)
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
	return out
}

async function getReadyRegistration(): Promise<ServiceWorkerRegistration | null> {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
	try {
		return await navigator.serviceWorker.ready
	} catch {
		return null
	}
}

/**
 * Subscribe the current browser to push, registering the resulting
 * subscription with the household. Returns the subscription on success or
 * null on any failure (no SW, missing key, push not supported, etc.).
 */
export async function subscribeToPush(): Promise<PushSubscription | null> {
	const reg = await getReadyRegistration()
	if (!reg) return null

	const keyResp = await fetch('/api/push/public-key', { credentials: 'same-origin' })
	if (!keyResp.ok) return null
	const { publicKey } = (await keyResp.json()) as { publicKey: string }

	const existing = await reg.pushManager.getSubscription()
	const sub =
		existing ??
		(await reg.pushManager
			.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(publicKey),
			})
			.catch(() => null))
	if (!sub) return null

	const resp = await fetch('/api/push/subscribe', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'same-origin',
		body: JSON.stringify(sub.toJSON()),
	})
	if (!resp.ok) {
		// Best-effort: drop the local sub so the next attempt can re-subscribe.
		await sub.unsubscribe().catch(() => undefined)
		return null
	}
	return sub
}

/**
 * Unsubscribe the current browser. Tells the household to drop the row
 * before unsubscribing locally so a transient server error doesn't leave
 * the server holding a stale subscription.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
	const reg = await getReadyRegistration()
	if (!reg) return false
	const sub = await reg.pushManager.getSubscription()
	if (!sub) return true
	await fetch('/api/push/subscribe', {
		method: 'DELETE',
		headers: { 'content-type': 'application/json' },
		credentials: 'same-origin',
		body: JSON.stringify({ endpoint: sub.endpoint }),
	}).catch(() => undefined)
	return sub.unsubscribe().catch(() => false)
}

/**
 * Whether this browser currently has an active push subscription. Used by
 * the toggle to render "Subscribed" vs "Subscribe" without doing the full
 * registration round trip.
 */
export async function hasPushSubscription(): Promise<boolean> {
	const reg = await getReadyRegistration()
	if (!reg) return false
	const sub = await reg.pushManager.getSubscription().catch(() => null)
	return sub !== null
}
