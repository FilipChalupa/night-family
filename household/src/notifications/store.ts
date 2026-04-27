import { eq, desc } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { notificationChannels, notificationDeliveries } from '../db/schema.ts'
import type { Db } from '../db/index.ts'
import type { SecretCipher } from '../crypto/secrets.ts'

export type NotificationEventName =
	| 'task.failed'
	| 'pr.merged'
	| 'quota_exceeded'
	| 'summarize.result'
	| 'member.disconnected'
	| 'token.revoked'

export type ChannelKind = 'webhook' | 'smtp'

export interface WebhookConfig {
	url: string
	headers?: Record<string, string>
}

export interface SmtpConfig {
	host: string
	port: number
	user: string
	pass: string
	from: string
	to: string
}

export type ChannelConfig = WebhookConfig | SmtpConfig

export interface ChannelRecord {
	id: string
	name: string
	kind: ChannelKind
	config: ChannelConfig
	subscribedEvents: NotificationEventName[]
	createdAt: Date
}

export interface DeliveryRecord {
	id: string
	channelId: string
	event: NotificationEventName
	payload: unknown
	status: 'sent' | 'failed'
	error: string | null
	createdAt: Date
}

export class NotificationStore {
	constructor(
		private readonly db: Db,
		private readonly cipher: SecretCipher,
	) {}

	list(): ChannelRecord[] {
		const rows = this.db.select().from(notificationChannels).all()
		return rows.map((r) => this.decode(r))
	}

	get(id: string): ChannelRecord | null {
		const rows = this.db
			.select()
			.from(notificationChannels)
			.where(eq(notificationChannels.id, id))
			.all()
		const r = rows[0]
		return r ? this.decode(r) : null
	}

	create(opts: {
		name: string
		kind: ChannelKind
		config: ChannelConfig
		subscribedEvents: NotificationEventName[]
	}): ChannelRecord {
		const id = randomBytes(8).toString('base64url')
		const configEnc = this.cipher.encrypt(JSON.stringify(opts.config))
		const subscribedEvents = JSON.stringify(opts.subscribedEvents)
		this.db
			.insert(notificationChannels)
			.values({
				id,
				name: opts.name,
				kind: opts.kind,
				configEnc,
				subscribedEvents,
			})
			.run()
		return this.get(id)!
	}

	update(
		id: string,
		opts: {
			name?: string
			config?: ChannelConfig
			subscribedEvents?: NotificationEventName[]
		},
	): ChannelRecord | null {
		const existing = this.get(id)
		if (!existing) return null
		const configEnc = opts.config ? this.cipher.encrypt(JSON.stringify(opts.config)) : undefined
		const subscribedEvents = opts.subscribedEvents
			? JSON.stringify(opts.subscribedEvents)
			: undefined
		this.db
			.update(notificationChannels)
			.set({
				...(opts.name ? { name: opts.name } : {}),
				...(configEnc ? { configEnc } : {}),
				...(subscribedEvents ? { subscribedEvents } : {}),
			})
			.where(eq(notificationChannels.id, id))
			.run()
		return this.get(id)
	}

	delete(id: string): boolean {
		const result = this.db
			.delete(notificationChannels)
			.where(eq(notificationChannels.id, id))
			.run()
		return result.changes > 0
	}

	recordDelivery(opts: {
		channelId: string
		event: NotificationEventName
		payload: unknown
		status: 'sent' | 'failed'
		error?: string
	}): void {
		const id = randomBytes(8).toString('base64url')
		this.db
			.insert(notificationDeliveries)
			.values({
				id,
				channelId: opts.channelId,
				event: opts.event,
				payload: JSON.stringify(opts.payload),
				status: opts.status,
				error: opts.error ?? null,
			})
			.run()
	}

	listDeliveries(channelId?: string): DeliveryRecord[] {
		const rows = channelId
			? this.db
					.select()
					.from(notificationDeliveries)
					.where(eq(notificationDeliveries.channelId, channelId))
					.orderBy(desc(notificationDeliveries.createdAt))
					.limit(100)
					.all()
			: this.db
					.select()
					.from(notificationDeliveries)
					.orderBy(desc(notificationDeliveries.createdAt))
					.limit(100)
					.all()
		return rows.map((r) => ({
			id: r.id,
			channelId: r.channelId,
			event: r.event as NotificationEventName,
			payload: JSON.parse(r.payload) as unknown,
			status: r.status as 'sent' | 'failed',
			error: r.error,
			createdAt: r.createdAt,
		}))
	}

	private decode(r: {
		id: string
		name: string
		kind: string
		configEnc: string
		subscribedEvents: string
		createdAt: Date
	}): ChannelRecord {
		const config = JSON.parse(this.cipher.decrypt(r.configEnc)) as ChannelConfig
		const subscribedEvents = JSON.parse(r.subscribedEvents) as NotificationEventName[]
		return {
			id: r.id,
			name: r.name,
			kind: r.kind as ChannelKind,
			config,
			subscribedEvents,
			createdAt: r.createdAt,
		}
	}
}
