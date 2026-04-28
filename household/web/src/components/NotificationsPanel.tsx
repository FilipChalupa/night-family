import {
	Alert,
	Box,
	Button,
	Checkbox,
	FormControlLabel,
	FormGroup,
	MenuItem,
	Paper,
	Stack,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	TextField,
	Tooltip,
	Typography,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
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

	if (loading) return <EmptyBox>Loading notification channels…</EmptyBox>
	if (error) return <Alert severity="error">{error}</Alert>

	const failedDeliveries = deliveries.filter((d) => d.status === 'failed')

	return (
		<Stack spacing={2}>
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
					<Box>
						<Button
							variant="outlined"
							size="small"
							startIcon={<AddIcon />}
							onClick={() => setShowForm(true)}
						>
							Add channel
						</Button>
					</Box>
				)
			) : null}

			{channels.length === 0 ? (
				<EmptyBox>
					No notification channels configured. Add a webhook or SMTP channel to get
					notified on events.
				</EmptyBox>
			) : (
				<TableContainer component={Paper} variant="outlined">
					<Table size="small">
						<TableHead>
							<TableRow>
								<TableCell>Name</TableCell>
								<TableCell>Type</TableCell>
								<TableCell>Events</TableCell>
								<TableCell>Created</TableCell>
								<TableCell />
							</TableRow>
						</TableHead>
						<TableBody>
							{channels.map((ch) => (
								<TableRow key={ch.id} hover>
									<TableCell>
										<Typography sx={{ fontWeight: 600 }}>{ch.name}</Typography>
									</TableCell>
									<TableCell>
										<Typography variant="body2" color="text.secondary">
											{ch.kind}
										</Typography>
									</TableCell>
									<TableCell>
										<Typography variant="caption" color="text.secondary">
											{ch.subscribedEvents.join(', ') || '—'}
										</Typography>
									</TableCell>
									<TableCell>
										<Tooltip title={ch.createdAt}>
											<Typography variant="body2" color="text.secondary">
												{new Date(ch.createdAt).toLocaleDateString()}
											</Typography>
										</Tooltip>
									</TableCell>
									<TableCell align="right">
										{canManage ? (
											<Button
												size="small"
												variant="outlined"
												color="error"
												onClick={() => void deleteChannel(ch.id, ch.name)}
											>
												Delete
											</Button>
										) : null}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</TableContainer>
			)}

			{failedDeliveries.length > 0 ? (
				<Stack spacing={1}>
					<Typography variant="overline" color="error" sx={{ letterSpacing: '0.08em' }}>
						Failed deliveries ({failedDeliveries.length})
					</Typography>
					<TableContainer component={Paper} variant="outlined">
						<Table size="small">
							<TableHead>
								<TableRow>
									<TableCell>Event</TableCell>
									<TableCell>Channel</TableCell>
									<TableCell>Error</TableCell>
									<TableCell>Time</TableCell>
									<TableCell />
								</TableRow>
							</TableHead>
							<TableBody>
								{failedDeliveries.map((d) => (
									<TableRow key={d.id} hover>
										<TableCell>
											<Typography variant="body2" color="text.secondary">
												{d.event}
											</Typography>
										</TableCell>
										<TableCell>
											<Typography variant="body2" color="text.secondary">
												{channels.find((ch) => ch.id === d.channelId)
													?.name ?? d.channelId}
											</Typography>
										</TableCell>
										<TableCell>
											<Typography variant="caption" color="text.secondary">
												{d.error ?? '—'}
											</Typography>
										</TableCell>
										<TableCell>
											<Typography variant="body2" color="text.secondary">
												{new Date(d.createdAt).toLocaleDateString()}
											</Typography>
										</TableCell>
										<TableCell align="right">
											{canManage ? (
												<Button
													size="small"
													variant="outlined"
													onClick={() => void retryDelivery(d.id)}
												>
													Retry
												</Button>
											) : null}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</TableContainer>
				</Stack>
			) : null}
		</Stack>
	)
}

function ChannelForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
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

	const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			const r = await fetch('/api/notifications/channels', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: name.trim(),
					kind,
					config: buildConfig(),
					subscribedEvents,
				}),
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
		<Paper variant="outlined" sx={{ p: 2 }} component="form" onSubmit={submit}>
			<Stack spacing={2}>
				<Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
					<TextField
						label="Channel name"
						placeholder="e.g. Slack alerts"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						size="small"
						fullWidth
					/>
					<TextField
						select
						label="Type"
						value={kind}
						onChange={(e) => setKind(e.target.value as ChannelKind)}
						size="small"
						sx={{ minWidth: 200 }}
					>
						<MenuItem value="webhook">Webhook</MenuItem>
						<MenuItem value="smtp">SMTP / Email</MenuItem>
					</TextField>
				</Stack>

				{kind === 'webhook' ? (
					<TextField
						label="Webhook URL"
						type="url"
						placeholder="https://hooks.slack.com/…"
						value={webhookUrl}
						onChange={(e) => setWebhookUrl(e.target.value)}
						required
						size="small"
						fullWidth
					/>
				) : (
					<>
						<Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
							<TextField
								label="SMTP host"
								placeholder="smtp.sendgrid.net"
								value={smtpHost}
								onChange={(e) => setSmtpHost(e.target.value)}
								required
								size="small"
								fullWidth
							/>
							<TextField
								label="Port"
								type="number"
								value={smtpPort}
								onChange={(e) => setSmtpPort(e.target.value)}
								required
								size="small"
								sx={{ maxWidth: 140 }}
							/>
						</Stack>
						<Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
							<TextField
								label="Username"
								value={smtpUser}
								onChange={(e) => setSmtpUser(e.target.value)}
								required
								size="small"
								fullWidth
							/>
							<TextField
								label="Password / API key"
								type="password"
								value={smtpPass}
								onChange={(e) => setSmtpPass(e.target.value)}
								required
								size="small"
								fullWidth
							/>
						</Stack>
						<Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
							<TextField
								label="From"
								type="email"
								placeholder="agent@example.com"
								value={smtpFrom}
								onChange={(e) => setSmtpFrom(e.target.value)}
								required
								size="small"
								fullWidth
							/>
							<TextField
								label="To"
								type="email"
								placeholder="you@example.com"
								value={smtpTo}
								onChange={(e) => setSmtpTo(e.target.value)}
								required
								size="small"
								fullWidth
							/>
						</Stack>
					</>
				)}

				<Box>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Subscribe to events
					</Typography>
					<FormGroup row>
						{ALL_EVENTS.map((ev) => (
							<FormControlLabel
								key={ev}
								control={
									<Checkbox
										size="small"
										checked={subscribedEvents.includes(ev)}
										onChange={() => toggleEvent(ev)}
									/>
								}
								label={ev}
							/>
						))}
					</FormGroup>
				</Box>

				<Stack
					direction="row"
					spacing={2}
					sx={{ alignItems: 'center', justifyContent: 'flex-end' }}
				>
					{error ? (
						<Typography color="error" variant="body2" sx={{ mr: 'auto' }}>
							{error}
						</Typography>
					) : null}
					<Button variant="outlined" onClick={onCancel}>
						Cancel
					</Button>
					<Button type="submit" variant="contained" disabled={submitting || !name.trim()}>
						{submitting ? 'Saving…' : 'Add channel'}
					</Button>
				</Stack>
			</Stack>
		</Paper>
	)
}

function EmptyBox({ children }: { children: React.ReactNode }) {
	return (
		<Box
			sx={{
				p: 3,
				border: 1,
				borderStyle: 'dashed',
				borderColor: 'divider',
				borderRadius: 2,
				color: 'text.secondary',
				textAlign: 'center',
			}}
		>
			{children}
		</Box>
	)
}
