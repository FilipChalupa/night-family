import { useEffect, useState } from 'react'

type ChannelKind = 'webhook' | 'smtp'
type NotificationEvent =
	| 'task.failed'
	| 'pr.merged'
	| 'quota_exceeded'
	| 'summarize.result'
	| 'member.disconnected'
	| 'token.revoked'

interface Channel {
	id: string
	name: string
	kind: ChannelKind
	config: Record<string, unknown>
	subscribedEvents: NotificationEvent[]
	createdAt: string
}

interface Delivery {
	id: string
	channelId: string
	event: string
	status: 'sent' | 'failed'
	error: string | null
	createdAt: string
}

const ALL_EVENTS: NotificationEvent[] = [
	'task.failed',
	'pr.merged',
	'quota_exceeded',
	'summarize.result',
	'member.disconnected',
	'token.revoked',
]

interface Props {
	canManage: boolean
}

export function NotificationsPanel({ canManage }: Props) {
	const [channels, setChannels] = useState<Channel[]>([])
	const [deliveries, setDeliveries] = useState<Delivery[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showForm, setShowForm] = useState(false)

	const refresh = async () => {
		setLoading(true)
		setError(null)
		try {
			const [chRes, delRes] = await Promise.all([
				fetch('/api/notifications/channels'),
				fetch('/api/notifications/deliveries'),
			])
			if (!chRes.ok || !delRes.ok) throw new Error('Failed to load')
			const { channels: ch } = (await chRes.json()) as { channels: Channel[] }
			const { deliveries: del } = (await delRes.json()) as { deliveries: Delivery[] }
			setChannels(ch)
			setDeliveries(del)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setLoading(false)
		}
	}

	useEffect(() => {
		void refresh()
	}, [])

	const deleteChannel = async (id: string, name: string) => {
		if (!confirm(`Delete channel "${name}"?`)) return
		await fetch(`/api/notifications/channels/${id}`, { method: 'DELETE' })
		void refresh()
	}

	const retryDelivery = async (id: string) => {
		await fetch(`/api/notifications/deliveries/${id}/retry`, { method: 'POST' })
		void refresh()
	}

	if (loading) return <div className="empty">Loading notification channels…</div>
	if (error) return <div className="empty">Error: {error}</div>

	const failedDeliveries = deliveries.filter((d) => d.status === 'failed')

	return (
		<>
			{canManage ? (
				showForm ? (
					<ChannelForm
						onCreated={() => {
							setShowForm(false)
							void refresh()
						}}
						onCancel={() => setShowForm(false)}
					/>
				) : (
					<div className="panel-actions">
						<button type="button" className="ghost" onClick={() => setShowForm(true)}>
							+ Add channel
						</button>
					</div>
				)
			) : null}

			{channels.length === 0 ? (
				<div className="empty">
					No notification channels configured. Add a webhook or SMTP channel to get
					notified on events.
				</div>
			) : (
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th>Type</th>
							<th>Events</th>
							<th>Created</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{channels.map((ch) => (
							<tr key={ch.id}>
								<td>
									<strong>{ch.name}</strong>
								</td>
								<td className="dim">{ch.kind}</td>
								<td className="dim" style={{ fontSize: 11 }}>
									{ch.subscribedEvents.join(', ') || '—'}
								</td>
								<td className="dim">{new Date(ch.createdAt).toLocaleDateString()}</td>
								<td>
									{canManage ? (
										<button
											type="button"
											className="ghost"
											onClick={() => void deleteChannel(ch.id, ch.name)}
										>
											Delete
										</button>
									) : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			{failedDeliveries.length > 0 ? (
				<>
					<h3 style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--red, #c00)' }}>
						Failed deliveries ({failedDeliveries.length})
					</h3>
					<table>
						<thead>
							<tr>
								<th>Event</th>
								<th>Channel</th>
								<th>Error</th>
								<th>Time</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{failedDeliveries.map((d) => (
								<tr key={d.id}>
									<td className="dim">{d.event}</td>
									<td className="dim">
										{channels.find((ch) => ch.id === d.channelId)?.name ??
											d.channelId}
									</td>
									<td className="dim" style={{ fontSize: 11 }}>
										{d.error ?? '—'}
									</td>
									<td className="dim">{new Date(d.createdAt).toLocaleDateString()}</td>
									<td>
										{canManage ? (
											<button
												type="button"
												className="ghost"
												onClick={() => void retryDelivery(d.id)}
											>
												Retry
											</button>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			) : null}
		</>
	)
}

function ChannelForm({
	onCreated,
	onCancel,
}: {
	onCreated: () => void
	onCancel: () => void
}) {
	const [name, setName] = useState('')
	const [kind, setKind] = useState<ChannelKind>('webhook')
	const [webhookUrl, setWebhookUrl] = useState('')
	const [smtpHost, setSmtpHost] = useState('')
	const [smtpPort, setSmtpPort] = useState('587')
	const [smtpUser, setSmtpUser] = useState('')
	const [smtpPass, setSmtpPass] = useState('')
	const [smtpFrom, setSmtpFrom] = useState('')
	const [smtpTo, setSmtpTo] = useState('')
	const [subscribedEvents, setSubscribedEvents] = useState<NotificationEvent[]>([
		'task.failed',
		'member.disconnected',
	])
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const toggleEvent = (ev: NotificationEvent) => {
		setSubscribedEvents((prev) =>
			prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev],
		)
	}

	const buildConfig = () => {
		if (kind === 'webhook') return { url: webhookUrl }
		return {
			host: smtpHost,
			port: parseInt(smtpPort, 10),
			user: smtpUser,
			pass: smtpPass,
			from: smtpFrom,
			to: smtpTo,
		}
	}

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			const r = await fetch('/api/notifications/channels', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: name.trim(), kind, config: buildConfig(), subscribedEvents }),
			})
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string }
				throw new Error(b.error ?? `HTTP ${r.status}`)
			}
			onCreated()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<form className="task-form" onSubmit={submit}>
			<div className="row">
				<div className="field">
					<label htmlFor="ch-name">Channel name</label>
					<input
						id="ch-name"
						type="text"
						placeholder="e.g. Slack alerts"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
					/>
				</div>
				<div className="field">
					<label htmlFor="ch-kind">Type</label>
					<select
						id="ch-kind"
						value={kind}
						onChange={(e) => setKind(e.target.value as ChannelKind)}
					>
						<option value="webhook">Webhook</option>
						<option value="smtp">SMTP / Email</option>
					</select>
				</div>
			</div>

			{kind === 'webhook' ? (
				<div className="row">
					<div className="field" style={{ flex: 1 }}>
						<label htmlFor="ch-url">Webhook URL</label>
						<input
							id="ch-url"
							type="url"
							placeholder="https://hooks.slack.com/…"
							value={webhookUrl}
							onChange={(e) => setWebhookUrl(e.target.value)}
							required
						/>
					</div>
				</div>
			) : (
				<>
					<div className="row">
						<div className="field">
							<label htmlFor="ch-host">SMTP host</label>
							<input
								id="ch-host"
								type="text"
								placeholder="smtp.sendgrid.net"
								value={smtpHost}
								onChange={(e) => setSmtpHost(e.target.value)}
								required
							/>
						</div>
						<div className="field" style={{ maxWidth: 100 }}>
							<label htmlFor="ch-port">Port</label>
							<input
								id="ch-port"
								type="number"
								value={smtpPort}
								onChange={(e) => setSmtpPort(e.target.value)}
								required
							/>
						</div>
					</div>
					<div className="row">
						<div className="field">
							<label htmlFor="ch-user">Username</label>
							<input
								id="ch-user"
								type="text"
								value={smtpUser}
								onChange={(e) => setSmtpUser(e.target.value)}
								required
							/>
						</div>
						<div className="field">
							<label htmlFor="ch-pass">Password / API key</label>
							<input
								id="ch-pass"
								type="password"
								value={smtpPass}
								onChange={(e) => setSmtpPass(e.target.value)}
								required
							/>
						</div>
					</div>
					<div className="row">
						<div className="field">
							<label htmlFor="ch-from">From</label>
							<input
								id="ch-from"
								type="email"
								placeholder="agent@example.com"
								value={smtpFrom}
								onChange={(e) => setSmtpFrom(e.target.value)}
								required
							/>
						</div>
						<div className="field">
							<label htmlFor="ch-to">To</label>
							<input
								id="ch-to"
								type="email"
								placeholder="you@example.com"
								value={smtpTo}
								onChange={(e) => setSmtpTo(e.target.value)}
								required
							/>
						</div>
					</div>
				</>
			)}

			<div className="field">
				<label>Subscribe to events</label>
				<div className="row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
					{ALL_EVENTS.map((ev) => (
						<label
							key={ev}
							style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}
						>
							<input
								type="checkbox"
								checked={subscribedEvents.includes(ev)}
								onChange={() => toggleEvent(ev)}
							/>
							{ev}
						</label>
					))}
				</div>
			</div>

			<div className="row end">
				{error ? <span className="error">{error}</span> : null}
				<button type="button" className="ghost" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" disabled={submitting || !name.trim()}>
					{submitting ? 'Saving…' : 'Add channel'}
				</button>
			</div>
		</form>
	)
}
