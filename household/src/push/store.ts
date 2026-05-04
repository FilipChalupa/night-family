import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { pushSubscriptions } from '../db/schema.ts'

export interface PushSubscriptionRecord {
	id: string
	userLogin: string
	endpoint: string
	keys: { p256dh: string; auth: string }
}

/**
 * Storage for browser Web Push subscriptions. Identity is the endpoint —
 * the same browser re-subscribing replaces the prior row (re-issued keys
 * are fine; the endpoint is the stable handle the push service knows about).
 */
export class PushSubscriptionStore {
	constructor(private readonly db: Db) {}

	upsert(input: {
		userLogin: string
		endpoint: string
		p256dh: string
		auth: string
	}): PushSubscriptionRecord {
		const existing = this.db
			.select()
			.from(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, input.endpoint))
			.all()[0]
		if (existing) {
			this.db
				.update(pushSubscriptions)
				.set({
					userLogin: input.userLogin,
					p256dh: input.p256dh,
					auth: input.auth,
				})
				.where(eq(pushSubscriptions.endpoint, input.endpoint))
				.run()
			return {
				id: existing.id,
				userLogin: input.userLogin,
				endpoint: input.endpoint,
				keys: { p256dh: input.p256dh, auth: input.auth },
			}
		}
		const id = randomUUID()
		this.db
			.insert(pushSubscriptions)
			.values({
				id,
				userLogin: input.userLogin,
				endpoint: input.endpoint,
				p256dh: input.p256dh,
				auth: input.auth,
				createdAt: new Date(),
			})
			.run()
		return {
			id,
			userLogin: input.userLogin,
			endpoint: input.endpoint,
			keys: { p256dh: input.p256dh, auth: input.auth },
		}
	}

	deleteByEndpoint(endpoint: string): boolean {
		const result = this.db
			.delete(pushSubscriptions)
			.where(eq(pushSubscriptions.endpoint, endpoint))
			.run()
		return result.changes > 0
	}

	list(): PushSubscriptionRecord[] {
		return this.db
			.select()
			.from(pushSubscriptions)
			.all()
			.map((r) => ({
				id: r.id,
				userLogin: r.userLogin,
				endpoint: r.endpoint,
				keys: { p256dh: r.p256dh, auth: r.auth },
			}))
	}
}
