import {
	Alert,
	Box,
	Button,
	Chip,
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
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { EmptyState } from '../routes/Root.tsx'
import type { MemberSnapshot } from '../types.ts'
import { useConfirm } from './ConfirmDialog.tsx'

export interface TokenRecord {
	id: string
	name: string
	created_at: string
	created_by: string
	revoked_at: string | null
	revoked_by: string | null
	usage_count: number
}

export interface TokensResponse {
	tokens: TokenRecord[]
}

/**
 * Shared TanStack Query handle for `/api/tokens`. The endpoint is admin-only,
 * so callers must gate the call themselves via `enabled`. Multiple consumers
 * with the same key share a single network fetch automatically.
 */
export function useTokensQuery(opts?: { enabled?: boolean }): UseQueryResult<TokensResponse> {
	return useQuery<TokensResponse>({
		queryKey: ['tokens'],
		queryFn: async () => {
			const r = await fetch('/api/tokens')
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string }
				throw new Error(b.error ?? `HTTP ${r.status}`)
			}
			return (await r.json()) as TokensResponse
		},
		enabled: opts?.enabled ?? true,
	})
}

interface Props {
	canManage: boolean
	members: MemberSnapshot[]
}

export function TokensPanel({ canManage, members }: Props) {
	const queryClient = useQueryClient()
	const [showForm, setShowForm] = useState(false)
	const [newToken, setNewToken] = useState<string | null>(null)
	const confirm = useConfirm()

	const tokensQuery = useTokensQuery()

	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ['tokens'] })
	}

	const revokeMutation = useMutation({
		mutationFn: async (id: string) => {
			const r = await fetch(`/api/tokens/${id}`, { method: 'DELETE' })
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string }
				throw new Error(b.error ?? `HTTP ${r.status}`)
			}
		},
		onSuccess: refresh,
	})

	const revoke = async (id: string, name: string, affectedMembers: MemberSnapshot[]) => {
		const ok = await confirm({
			title: 'Revoke token',
			description: (
				<>
					Revoke token <strong>{name}</strong>?
					{affectedMembers.length === 0 ? (
						<> No members are currently connected with this token.</>
					) : (
						<>
							<Box component="span" sx={{ display: 'block', mt: 1 }}>
								The following {affectedMembers.length === 1 ? 'member' : 'members'} will be
								disconnected immediately:
							</Box>
							<Box
								component="ul"
								sx={{ mt: 0.5, mb: 0, pl: 2.5, '& li': { mb: 0.25 } }}
							>
								{affectedMembers.map((m) => (
									<li key={m.sessionId}>
										<strong>{m.displayName || m.memberName}</strong>
										{m.displayName && m.displayName !== m.memberName
											? ` (@${m.memberName})`
											: ''}
									</li>
								))}
							</Box>
						</>
					)}
				</>
			),
			confirmLabel: 'Revoke',
			confirmColor: 'error',
		})
		if (!ok) return
		try {
			await revokeMutation.mutateAsync(id)
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err))
		}
	}

	if (tokensQuery.isLoading) return <EmptyState>Loading tokens…</EmptyState>
	if (tokensQuery.error)
		return <Alert severity="error">{(tokensQuery.error as Error).message}</Alert>
	const data = tokensQuery.data
	if (!data) return <EmptyState>No data.</EmptyState>

	const active = data.tokens.filter((t) => !t.revoked_at)
	const revoked = data.tokens.filter((t) => t.revoked_at)

	const membersByToken = new Map<string, MemberSnapshot[]>()
	for (const m of members) {
		const list = membersByToken.get(m.tokenId)
		if (list) list.push(m)
		else membersByToken.set(m.tokenId, [m])
	}

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
								<TableCell>Members using this token</TableCell>
								<TableCell />
							</TableRow>
						</TableHead>
						<TableBody>
							{active.map((t) => {
								const tokenMembers = membersByToken.get(t.id) ?? []
								return (
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
											<TokenMembersCell
												members={tokenMembers}
												usageCount={t.usage_count}
											/>
										</TableCell>
										<TableCell align="right">
											{canManage ? (
												<Button
													size="small"
													variant="outlined"
													color="error"
													onClick={() =>
														void revoke(t.id, t.name, tokenMembers)
													}
												>
													Revoke
												</Button>
											) : null}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				</TableContainer>
			) : (
				<EmptyState>No active tokens. Generate one to connect Members.</EmptyState>
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

	const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
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

function TokenMembersCell({
	members,
	usageCount,
}: {
	members: MemberSnapshot[]
	usageCount: number
}) {
	if (members.length === 0) {
		return (
			<Stack spacing={0.5}>
				<Typography variant="body2" color="text.secondary">
					— none connected
				</Typography>
				<Typography variant="caption" color="text.secondary">
					{usageCount.toLocaleString()} lifetime use{usageCount === 1 ? '' : 's'}
				</Typography>
			</Stack>
		)
	}
	return (
		<Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
			<Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
				{members.map((m) => (
					<Link
						key={m.sessionId}
						to="/members/$memberId"
						params={{ memberId: m.memberId }}
						style={{ textDecoration: 'none' }}
					>
						<Chip
							size="small"
							variant="outlined"
							color={m.status === 'busy' ? 'warning' : 'success'}
							label={m.displayName || m.memberName}
							clickable
						/>
					</Link>
				))}
			</Box>
			<Typography variant="caption" color="text.secondary">
				{usageCount.toLocaleString()} lifetime use{usageCount === 1 ? '' : 's'}
			</Typography>
		</Stack>
	)
}
