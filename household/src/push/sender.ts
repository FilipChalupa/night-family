/**
 * Fan-out helper for sending Web Push messages to every active subscription.
 * On 404/410 from the push service the subscription is dead and we drop it
 * from the store immediately — those rows would just keep failing forever
 * otherwise.
 */

import type { Logger } from 'pino'
import webpush, { type SendResult } from 'web-push'
import type { PushSubscriptionStore } from './store.ts'
import type { VapidKeys } from './vapid.ts'

/**
 * Wire payload pushed to the browser SW. Kept minimal — Chromium Android
 * caps the encrypted payload at ≈4 KB, and we only need a click-target.
 */
export interface PushPayload {
	title: string
	body: string
	taskId?: string | null
	tag?: string
}

interface Deps {
	store: PushSubscriptionStore
	keys: VapidKeys
	/** `mailto:` or `https://` URL identifying the sender per RFC 8292. */
	subject: string
	logger: Logger
}

export class PushSender {
	constructor(private readonly deps: Deps) {
		webpush.setVapidDetails(deps.subject, deps.keys.publicKey, deps.keys.privateKey)
	}

	async broadcast(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
		const subs = this.deps.store.list()
		if (subs.length === 0) return { sent: 0, pruned: 0 }

		const body = JSON.stringify(payload)
		const results = await Promise.allSettled(
			subs.map((s) =>
				webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, {
					TTL: 60,
				}),
			),
		)

		let sent = 0
		let pruned = 0
		for (let i = 0; i < results.length; i++) {
			const res = results[i]!
			const sub = subs[i]!
			if (res.status === 'fulfilled') {
				if (isExpired((res as PromiseFulfilledResult<SendResult>).value.statusCode)) {
					if (this.deps.store.deleteByEndpoint(sub.endpoint)) pruned++
				} else {
					sent++
				}
				continue
			}
			const err = res.reason as { statusCode?: number; message?: string }
			if (typeof err.statusCode === 'number' && isExpired(err.statusCode)) {
				if (this.deps.store.deleteByEndpoint(sub.endpoint)) pruned++
			} else {
				this.deps.logger.warn(
					{ endpoint: sub.endpoint.slice(0, 60), err: err.message },
					'web push delivery failed',
				)
			}
		}
		return { sent, pruned }
	}
}

function isExpired(statusCode: number): boolean {
	return statusCode === 404 || statusCode === 410
}
