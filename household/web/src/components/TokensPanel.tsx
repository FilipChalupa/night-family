import {
	Alert,
	Box,
	Button,
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

interface TokenRecord {
	id: string
	name: string
	created_at: string
	created_by: string
	revoked_at: string | null
	revoked_by: string | null
	usage_count: number
}

interface TokensResponse {
	tokens: TokenRecord[]
}

interface Props {
	canManage: boolean
}

export function TokensPanel({ canManage }: Props) {
	const [data, setData] = useState<TokensResponse | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showForm, setShowForm] = useState(false)
	const [newToken, setNewToken] = useState<string | null>(null)

	const refresh = () => {
		setLoading(true)
		setError(null)
		void fetch('/api/tokens')
			.then(async (r) => {
				if (!r.ok) {
					const b = (await r.json().catch(() => ({}))) as { error?: string }
					throw new Error(b.error ?? `HTTP ${r.status}`)
				}
				return r.json() as Promise<TokensResponse>
			})
			.then((body) => {
				setData(body)
				setLoading(false)
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : String(err))
				setLoading(false)
			})
	}

	useEffect(refresh, [])

	const revoke = async (id: string, name: string) => {
		if (!confirm(`Revoke token "${name}"? All members using it will be disconnected.`)) return
		const r = await fetch(`/api/tokens/${id}`, { method: 'DELETE' })
		if (!r.ok) {
			const b = (await r.json().catch(() => ({}))) as { error?: string }
			alert(b.error ?? `HTTP ${r.status}`)
			return
		}
		refresh()
	}

	if (loading) return <EmptyBox>Loading tokens…</EmptyBox>
	if (error) return <Alert severity="error">{error}</Alert>
	if (!data) return <EmptyBox>No data.</EmptyBox>

	const active = data.tokens.filter((t) => !t.revoked_at)
	const revoked = data.tokens.filter((t) => t.revoked_at)

	return (
		<Stack spacing={2}>
			{newToken ? (
				<Alert
					severity="success"
					variant="outlined"
					action={
						<Button
							size="small"
							onClick={() => {
								setNewToken(null)
								refresh()
							}}
						>
							Done
						</Button>
					}
				>
					<Typography sx={{ fontWeight: 600 }} gutterBottom>
						New token generated — copy it now, it will not be shown again:
					</Typography>
					<Box
						component="pre"
						sx={{
							fontFamily: 'monospace',
							fontSize: '0.85rem',
							p: 1.5,
							borderRadius: 1,
							border: 1,
							borderColor: 'divider',
							backgroundColor: 'background.default',
							wordBreak: 'break-all',
							whiteSpace: 'pre-wrap',
							m: 0,
						}}
					>
						{newToken}
					</Box>
				</Alert>
			) : null}

			{canManage ? (
				showForm ? (
					<TokenForm
						onCreated={(raw) => {
							setShowForm(false)
							setNewToken(raw)
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
							Generate token
						</Button>
					</Box>
				)
			) : null}

			{active.length > 0 ? (
				<TableContainer component={Paper} variant="outlined">
					<Table size="small">
						<TableHead>
							<TableRow>
								<TableCell>Name</TableCell>
								<TableCell>Created</TableCell>
								<TableCell>Created by</TableCell>
								<TableCell>Members connected</TableCell>
								<TableCell />
							</TableRow>
						</TableHead>
						<TableBody>
							{active.map((t) => (
								<TableRow key={t.id} hover>
									<TableCell>
										<Typography sx={{ fontWeight: 600 }}>{t.name}</Typography>
										<Typography variant="caption" color="text.secondary">
											id: {t.id}
										</Typography>
									</TableCell>
									<TableCell>
										<Tooltip title={t.created_at}>
											<Typography variant="body2" color="text.secondary">
												{new Date(t.created_at).toLocaleDateString()}
											</Typography>
										</Tooltip>
									</TableCell>
									<TableCell>
										<Typography variant="body2" color="text.secondary">
											{t.created_by}
										</Typography>
									</TableCell>
									<TableCell>
										<Typography variant="body2" color="text.secondary">
											{t.usage_count}
										</Typography>
									</TableCell>
									<TableCell align="right">
										{canManage ? (
											<Button
												size="small"
												variant="outlined"
												color="error"
												onClick={() => void revoke(t.id, t.name)}
											>
												Revoke
											</Button>
										) : null}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</TableContainer>
			) : (
				<EmptyBox>No active tokens. Generate one to connect Members.</EmptyBox>
			)}

			{revoked.length > 0 ? (
				<Stack spacing={1}>
					<Typography
						variant="overline"
						color="text.secondary"
						sx={{ letterSpacing: '0.08em' }}
					>
						Revoked tokens
					</Typography>
					<TableContainer component={Paper} variant="outlined" sx={{ opacity: 0.6 }}>
						<Table size="small">
							<TableHead>
								<TableRow>
									<TableCell>Name</TableCell>
									<TableCell>Revoked</TableCell>
									<TableCell>Revoked by</TableCell>
								</TableRow>
							</TableHead>
							<TableBody>
								{revoked.map((t) => (
									<TableRow key={t.id}>
										<TableCell>{t.name}</TableCell>
										<TableCell>
											<Typography variant="body2" color="text.secondary">
												{t.revoked_at
													? new Date(t.revoked_at).toLocaleDateString()
													: '—'}
											</Typography>
										</TableCell>
										<TableCell>
											<Typography variant="body2" color="text.secondary">
												{t.revoked_by ?? '—'}
											</Typography>
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

function TokenForm({
	onCreated,
	onCancel,
}: {
	onCreated: (raw: string) => void
	onCancel: () => void
}) {
	const [name, setName] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			const r = await fetch('/api/tokens', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: name.trim() }),
			})
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string }
				throw new Error(b.error ?? `HTTP ${r.status}`)
			}
			const body = (await r.json()) as { token: string }
			onCreated(body.token)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<Paper variant="outlined" sx={{ p: 2 }} component="form" onSubmit={submit}>
			<Stack spacing={2}>
				<TextField
					label="Token name"
					placeholder="e.g. laptop-fleet"
					value={name}
					onChange={(e) => setName(e.target.value)}
					required
					size="small"
					fullWidth
				/>
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
						{submitting ? 'Generating…' : 'Generate'}
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
