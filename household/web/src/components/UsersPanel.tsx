import {
	Alert,
	Box,
	Button,
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
import type { UserRecord, UserRole } from '../types.ts'

interface Props {
	canManage: boolean
	currentUsername: string | null
}

interface UsersResponse {
	primaryAdmin: string
	users: UserRecord[]
}

export function UsersPanel({ canManage, currentUsername }: Props) {
	const [data, setData] = useState<UsersResponse | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showForm, setShowForm] = useState(false)

	const refresh = () => {
		setLoading(true)
		setError(null)
		void fetch('/api/users')
			.then(async (response) => {
				if (!response.ok) {
					const body = (await response.json().catch(() => ({}))) as { error?: string }
					throw new Error(body.error ?? `HTTP ${response.status}`)
				}
				return response.json() as Promise<UsersResponse>
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

	const updateRole = async (username: string, role: UserRole) => {
		const response = await fetch(`/api/users/${encodeURIComponent(username)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ role }),
		})
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string }
			throw new Error(body.error ?? `HTTP ${response.status}`)
		}
		refresh()
	}

	const remove = async (username: string) => {
		if (!confirm(`Remove ${username} from dashboard access?`)) return
		const response = await fetch(`/api/users/${encodeURIComponent(username)}`, {
			method: 'DELETE',
		})
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string }
			throw new Error(body.error ?? `HTTP ${response.status}`)
		}
		refresh()
	}

	if (loading) return <EmptyBox>Loading users…</EmptyBox>
	if (error) return <Alert severity="error">{error}</Alert>
	if (!data) return <EmptyBox>No users loaded.</EmptyBox>

	return (
		<Stack spacing={2}>
			{canManage ? (
				showForm ? (
					<UserForm
						onCreated={() => {
							setShowForm(false)
							refresh()
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
							Add user
						</Button>
					</Box>
				)
			) : (
				<Alert severity="info" variant="outlined">
					You are signed in as readonly. User management is admin-only.
				</Alert>
			)}
			<TableContainer component={Paper} variant="outlined">
				<Table size="small">
					<TableHead>
						<TableRow>
							<TableCell>GitHub User</TableCell>
							<TableCell>Role</TableCell>
							<TableCell>Added</TableCell>
							<TableCell>Added By</TableCell>
							<TableCell />
						</TableRow>
					</TableHead>
					<TableBody>
						{data.users.map((user) => {
							const isPrimaryAdmin =
								user.username.toLowerCase() === data.primaryAdmin.toLowerCase()
							const isCurrentUser =
								currentUsername?.toLowerCase() === user.username.toLowerCase()
							return (
								<TableRow key={user.username} hover>
									<TableCell>
										<Typography sx={{ fontWeight: 600 }}>{user.username}</Typography>
										{isCurrentUser ? (
											<Typography variant="caption" color="text.secondary">
												you
											</Typography>
										) : null}
									</TableCell>
									<TableCell>
										{canManage ? (
											<TextField
												select
												value={user.role}
												disabled={isPrimaryAdmin}
												onChange={(e) => {
													void updateRole(
														user.username,
														e.target.value as UserRole,
													)
												}}
												size="small"
												sx={{ minWidth: 120 }}
											>
												<MenuItem value="admin">admin</MenuItem>
												<MenuItem value="readonly">readonly</MenuItem>
											</TextField>
										) : (
											<Typography variant="body2" color="text.secondary">
												{user.role}
											</Typography>
										)}
									</TableCell>
									<TableCell>
										<Tooltip title={user.added_at}>
											<Typography variant="body2" color="text.secondary">
												{new Date(user.added_at).toLocaleDateString()}
											</Typography>
										</Tooltip>
									</TableCell>
									<TableCell>
										<Typography variant="body2" color="text.secondary">
											{user.added_by}
										</Typography>
									</TableCell>
									<TableCell align="right">
										{canManage && !isPrimaryAdmin ? (
											<Button
												size="small"
												variant="outlined"
												color="error"
												onClick={() => {
													void remove(user.username)
												}}
											>
												Remove
											</Button>
										) : null}
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</TableContainer>
		</Stack>
	)
}

function UserForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
	const [username, setUsername] = useState('')
	const [role, setRole] = useState<UserRole>('readonly')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			const response = await fetch('/api/users', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username: username.trim(), role }),
			})
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { error?: string }
				throw new Error(body.error ?? `HTTP ${response.status}`)
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
						label="GitHub username"
						placeholder="octocat"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						required
						size="small"
						fullWidth
					/>
					<TextField
						select
						label="Role"
						value={role}
						onChange={(e) => setRole(e.target.value as UserRole)}
						size="small"
						sx={{ minWidth: 160 }}
					>
						<MenuItem value="readonly">readonly</MenuItem>
						<MenuItem value="admin">admin</MenuItem>
					</TextField>
				</Stack>
				<Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'flex-end' }}>
					{error ? (
						<Typography color="error" variant="body2" sx={{ mr: 'auto' }}>
							{error}
						</Typography>
					) : null}
					<Button variant="outlined" onClick={onCancel}>
						Cancel
					</Button>
					<Button type="submit" variant="contained" disabled={submitting || !username.trim()}>
						{submitting ? 'Saving…' : 'Add user'}
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
