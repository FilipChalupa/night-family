/**
 * Notification sender — fires outbound webhook / SMTP when key events occur.
 *
 * Delivery semantics: no auto-retry. Failed deliveries are logged in
 * `notification_deliveries` with status=failed; the UI shows a Retry button.
 */

import nodemailer from 'nodemailer'
import type { Logger } from 'pino'
import type {
	NotificationStore,
	NotificationEventName,
	WebhookConfig,
	SmtpConfig,
	ChannelConfig,
	ChannelKind,
} from './store.ts'

export class NotificationSender {
	constructor(
		private readonly store: NotificationStore,
		private readonly logger: Logger,
	) {}

	async fire(event: NotificationEventName, payload: Record<string, unknown>): Promise<void> {
		const channels = this.store.list().filter((ch) => ch.subscribedEvents.includes(event))
		await Promise.allSettled(
			channels.map((ch) => this.sendToChannel(ch.id, ch.kind, ch.config, event, payload)),
		)
	}

	/**
	 * Send a synthetic test payload through a channel without recording it
	 * in the deliveries history. Throws if the underlying transport fails so
	 * the API layer can surface the error directly.
	 */
	async sendTest(kind: ChannelKind, config: ChannelConfig): Promise<void> {
		const payload = {
			message: 'This is a test notification from Night Family.',
			ts: new Date().toISOString(),
		}
		if (kind === 'webhook') {
			await sendWebhook(config as WebhookConfig, 'test', payload)
		} else if (kind === 'smtp') {
			await sendSmtp(config as SmtpConfig, 'test', payload)
		} else {
			throw new Error(`unsupported channel kind: ${kind as string}`)
		}
	}

	async retryDelivery(deliveryId: string): Promise<boolean> {
		const deliveries = this.store.listDeliveries()
		const delivery = deliveries.find((d) => d.id === deliveryId)
		if (!delivery || delivery.status !== 'failed') return false
		const channel = this.store.get(delivery.channelId)
		if (!channel) return false
		await this.sendToChannel(
			channel.id,
			channel.kind,
			channel.config,
			delivery.event,
			delivery.payload as Record<string, unknown>,
		)
		return true
	}

	private async sendToChannel(
		channelId: string,
		kind: string,
		config: ChannelConfig,
		event: NotificationEventName,
		payload: Record<string, unknown>,
	): Promise<void> {
		try {
			if (kind === 'webhook') {
				await sendWebhook(config as WebhookConfig, event, payload)
			} else if (kind === 'smtp') {
				await sendSmtp(config as SmtpConfig, event, payload)
			}
			this.store.recordDelivery({ channelId, event, payload, status: 'sent' })
			this.logger.info({ channelId, event }, 'notification sent')
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err)
			this.store.recordDelivery({ channelId, event, payload, status: 'failed', error })
			this.logger.warn({ channelId, event, error }, 'notification failed')
		}
	}
}

async function sendWebhook(
	config: WebhookConfig,
	event: NotificationEventName | 'test',
	payload: Record<string, unknown>,
): Promise<void> {
	const ts = new Date().toISOString()
	const format = config.format ?? 'generic'
	let body: string
	if (format === 'slack') {
		body = JSON.stringify({ text: renderText(event, payload, ts) })
	} else if (format === 'discord') {
		// Discord caps `content` at 2000 chars.
		body = JSON.stringify({ content: renderText(event, payload, ts).slice(0, 1900) })
	} else {
		body = JSON.stringify({ event, payload, ts })
	}
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...config.headers,
	}
	const res = await fetch(config.url, { method: 'POST', headers, body })
	if (!res.ok) {
		throw new Error(`webhook returned ${res.status}`)
	}
}

function renderText(event: string, payload: Record<string, unknown>, ts: string): string {
	const detail = JSON.stringify(payload, null, 2)
	return `[Night Family] ${event} · ${ts}\n\`\`\`\n${detail}\n\`\`\``
}

async function sendSmtp(
	config: SmtpConfig,
	event: NotificationEventName | 'test',
	payload: Record<string, unknown>,
): Promise<void> {
	const transporter = nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.port === 465,
		auth: { user: config.user, pass: config.pass },
	})
	await transporter.sendMail({
		from: config.from,
		to: config.to,
		subject: `[Night Family] ${event}`,
		text: JSON.stringify(payload, null, 2),
	})
}
