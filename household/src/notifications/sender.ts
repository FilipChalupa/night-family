/**
 * Notification sender — fires outbound webhook / SMTP when key events occur.
 *
 * Delivery semantics: no auto-retry. Failed deliveries are logged in
 * `notification_deliveries` with status=failed; the UI shows a Retry button.
 */

import nodemailer from 'nodemailer'
import type { Logger } from 'pino'
import { assertPublicUrl } from './ssrf.ts'
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
		body = JSON.stringify(buildSlackMessage(event, payload, ts))
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
	// SSRF guard: the URL is admin-supplied, so refuse non-public targets before
	// making the request (metadata endpoints, localhost, RFC 1918, …).
	await assertPublicUrl(config.url)
	// `redirect: 'error'` so a 3xx to an internal host can't bypass the guard.
	const res = await fetch(config.url, { method: 'POST', headers, body, redirect: 'error' })
	if (!res.ok) {
		throw new Error(`webhook returned ${res.status}`)
	}
}

function renderText(event: string, payload: Record<string, unknown>, ts: string): string {
	const detail = JSON.stringify(payload, null, 2)
	return `[Night Family] ${event} · ${ts}\n\`\`\`\n${detail}\n\`\`\``
}

interface SlackField {
	label: string
	value: string
}

interface SlackAction {
	label: string
	url: string
}

interface SlackEventDescriptor {
	title: string
	color: 'good' | 'warning' | 'danger' | string
	fields: SlackField[]
	body?: string
	actions: SlackAction[]
}

/**
 * Slack incoming-webhook payload built from `attachments` blocks. The
 * outer `attachments[].color` paints the vertical bar (good/warning/danger)
 * for at-a-glance triage; inner `blocks` supply structured headers,
 * fields, and link buttons so the message reads cleanly without making
 * the reader expand a JSON code block.
 */
export function buildSlackMessage(
	event: NotificationEventName | 'test',
	payload: Record<string, unknown>,
	ts: string,
): {
	username: string
	icon_emoji: string
	text: string
	attachments: Array<{ color: string; blocks: unknown[] }>
} {
	const desc = describeSlackEvent(event, payload)
	const blocks: unknown[] = [{ type: 'header', text: { type: 'plain_text', text: desc.title } }]
	if (desc.fields.length > 0) {
		blocks.push({
			type: 'section',
			fields: desc.fields.map((f) => ({
				type: 'mrkdwn',
				text: `*${f.label}*\n${f.value}`,
			})),
		})
	}
	if (desc.body) {
		blocks.push({
			type: 'section',
			text: { type: 'mrkdwn', text: desc.body },
		})
	}
	if (desc.actions.length > 0) {
		blocks.push({
			type: 'actions',
			elements: desc.actions.map((a) => ({
				type: 'button',
				text: { type: 'plain_text', text: a.label },
				url: a.url,
			})),
		})
	}
	blocks.push({
		type: 'context',
		elements: [{ type: 'mrkdwn', text: `Night Family · \`${event}\` · ${ts}` }],
	})

	// `username` + `icon_emoji` override the incoming-webhook bot identity so
	// every workspace shows a consistent "Night Family 🌙" sender regardless
	// of how the webhook integration was named when installed. `:crescent_moon:`
	// is a Unicode emoji, so no custom workspace emoji upload is required.
	// `text` is the notification fallback (mobile pop, sidebar preview);
	// `blocks` are what's rendered in-channel.
	return {
		username: 'Night Family',
		icon_emoji: ':crescent_moon:',
		text: `[Night Family] ${desc.title}`,
		attachments: [{ color: desc.color, blocks }],
	}
}

function describeSlackEvent(
	event: NotificationEventName | 'test',
	payload: Record<string, unknown>,
): SlackEventDescriptor {
	switch (event) {
		case 'task.failed':
			return {
				title: 'Task failed',
				color: 'danger',
				fields: [
					...taskTitleField(payload),
					...stringField('Reason', payload.reason),
					...stringField('Task ID', payload.taskId, { mono: true }),
				],
				actions: [],
			}
		case 'quota_exceeded':
			return {
				title: 'Quota exceeded',
				color: 'danger',
				fields: [
					...taskTitleField(payload),
					...stringField('Reason', payload.reason),
					...stringField('Task ID', payload.taskId, { mono: true }),
				],
				actions: [],
			}
		case 'pr.merged':
			return {
				title: 'PR merged',
				color: 'good',
				fields: [
					...taskTitleField(payload),
					...stringField('Task ID', payload.taskId, { mono: true }),
				],
				actions: stringValue(payload.prUrl)
					? [{ label: 'View PR', url: stringValue(payload.prUrl)! }]
					: [],
			}
		case 'summarize.result': {
			const summary = stringValue(payload.summary)
			const desc: SlackEventDescriptor = {
				title: 'Summary ready',
				color: 'good',
				fields: [
					...taskTitleField(payload),
					...stringField('Task ID', payload.taskId, { mono: true }),
				],
				actions: [],
			}
			if (summary) desc.body = truncate(summary, 2500)
			return desc
		}
		case 'triage.result': {
			const outcome = stringValue(payload.outcome) ?? 'unknown'
			const repo = stringValue(payload.repo)
			const issueNumber = numberValue(payload.issueNumber)
			const issueUrl =
				repo && issueNumber !== null
					? `https://github.com/${repo}/issues/${issueNumber}`
					: null
			return {
				title: `Triage: ${outcome}`,
				color: outcome === 'plan' ? 'good' : outcome === 'question' ? 'warning' : '#888888',
				fields: [
					...taskTitleField(payload),
					...stringField('Repo', repo, { mono: true }),
					...(issueNumber !== null ? [{ label: 'Issue', value: `#${issueNumber}` }] : []),
					...stringField('Size', payload.size),
				],
				actions: issueUrl ? [{ label: 'Open issue', url: issueUrl }] : [],
			}
		}
		case 'member.disconnected':
			return {
				title: 'Member disconnected',
				color: 'warning',
				fields: stringField('Session', payload.sessionId, { mono: true }),
				actions: [],
			}
		case 'token.revoked':
			return {
				title: 'Token revoked',
				color: 'warning',
				fields: [
					...stringField('Token', payload.tokenName ?? payload.tokenId),
					...stringField('Revoked by', payload.revokedBy),
				],
				actions: [],
			}
		case 'test':
			return {
				title: 'Test notification',
				color: '#888888',
				fields: stringField('Message', payload.message),
				actions: [],
			}
	}
}

function taskTitleField(payload: Record<string, unknown>): SlackField[] {
	return stringField('Task', payload.title)
}

function stringField(label: string, value: unknown, opts: { mono?: boolean } = {}): SlackField[] {
	const v = stringValue(value)
	if (!v) return []
	return [{ label, value: opts.mono ? `\`${v}\`` : v }]
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.length > 0) return value
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	return null
}

function numberValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string') {
		const n = Number.parseInt(value, 10)
		if (Number.isFinite(n)) return n
	}
	return null
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return s.slice(0, max - 1) + '…'
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
	try {
		await transporter.sendMail({
			from: config.from,
			to: config.to,
			subject: `[Night Family] ${event}`,
			text: JSON.stringify(payload, null, 2),
		})
	} finally {
		// A transporter is created per send; close it so its connection pool and
		// timers don't leak over the process lifetime.
		transporter.close()
	}
}
