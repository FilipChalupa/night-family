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

interface RepoBinding {
	repo: string
	hasPat: boolean
	createdAt: string
	updatedAt: string
}

export function ReposPanel({ canManage }: { canManage: boolean }) {
	const [repos, setRepos] = useState<RepoBinding[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showForm, setShowForm] = useState(false)

	const refresh = () => {
		setLoading(true)
		void fetch('/api/repos')
			.then((r) => r.json())
			.then((j: { repos: RepoBinding[] }) => {
				setRepos(j.repos)
				setLoading(false)
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : String(err))
				setLoading(false)
			})
	}

	useEffect(refresh, [])

	const remove = async (repo: string) => {
		if (!confirm(`Remove repo binding for ${repo}?`)) return
		await fetch(`/api/repos/${encodeURIComponent(repo)}`, { method: 'DELETE' })
		refresh()
	}

	if (loading) return <EmptyBox>Loading repos…</EmptyBox>
	if (error) return <Alert severity="error">{error}</Alert>

	return (
		<Stack spacing={2}>
			{canManage ? (
				showForm ? (
					<RepoForm
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
							Add repo binding
						</Button>
					</Box>
				)
			) : (
				<Alert severity="info" variant="outlined">
					Repository bindings are visible here, but changing them is admin-only.
				</Alert>
			)}

			{repos.length === 0 ? (
				<EmptyBox>
					No repo bindings yet. Add one to enable issue import + PR tracking.
				</EmptyBox>
			) : (
				<TableContainer component={Paper} variant="outlined">
					<Table size="small">
						<TableHead>
							<TableRow>
								<TableCell>Repo</TableCell>
								<TableCell>PAT</TableCell>
								<TableCell>Webhook URL</TableCell>
								<TableCell>Created</TableCell>
								<TableCell />
							</TableRow>
						</TableHead>
						<TableBody>
							{repos.map((r) => (
								<TableRow key={r.repo} hover>
									<TableCell>
										<Typography
											component="code"
											sx={{ fontFamily: 'monospace' }}
										>
											{r.repo}
										</Typography>
									</TableCell>
									<TableCell>
										<Typography
											variant="body2"
											color={r.hasPat ? 'text.primary' : 'text.secondary'}
										>
											{r.hasPat ? '✓ stored' : 'missing'}
										</Typography>
									</TableCell>
									<TableCell>
										<Typography variant="caption" color="text.secondary">
											{`${window.location.origin}/webhooks/github`}
										</Typography>
									</TableCell>
									<TableCell>
										<Tooltip title={r.createdAt}>
											<Typography variant="body2" color="text.secondary">
												{new Date(r.createdAt).toLocaleDateString()}
											</Typography>
										</Tooltip>
									</TableCell>
									<TableCell align="right">
										{canManage ? (
											<Button
												size="small"
												variant="outlined"
												color="error"
												onClick={() => {
													void remove(r.repo)
												}}
											>
												Remove
											</Button>
										) : null}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</TableContainer>
			)}
		</Stack>
	)
}

function RepoForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
	const [repo, setRepo] = useState('')
	const [secret, setSecret] = useState('')
	const [pat, setPat] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			const res = await fetch('/api/repos', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					repo: repo.trim(),
					webhook_secret: secret,
					pat: pat.trim() || null,
				}),
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				throw new Error(body.error ?? `HTTP ${res.status}`)
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
				<Alert severity="info" variant="outlined">
					<Typography variant="body2" gutterBottom>
						<strong>Webhook secret:</strong> In the GitHub repo, go to{' '}
						<em>Settings → Webhooks → Add webhook</em>. Set Payload URL to{' '}
						<Typography component="code" sx={{ fontFamily: 'monospace' }}>
							{`${window.location.origin}/webhooks/github`}
						</Typography>
						, content type to <em>application/json</em>, and choose any secret — paste
						it here.
					</Typography>
					<Typography variant="body2">
						<strong>GitHub PAT:</strong> In GitHub, go to{' '}
						<em>
							Settings → Developer settings → Fine-grained tokens → Generate new token
						</em>
						. Pick this repository and grant the following <strong>Repository
						permissions</strong>:
					</Typography>
					<Typography variant="body2" component="ul" sx={{ my: 0, pl: 3 }}>
						<li>
							<strong>Contents: Read and write</strong> — Members push commits to
							task branches.
						</li>
						<li>
							<strong>Pull requests: Read and write</strong> — Members open PRs and
							update PR status.
						</li>
						<li>
							<strong>Issues: Read-only</strong> — used for issue import.
						</li>
					</Typography>
					<Typography variant="body2">
						The PAT is technically optional (binding works without it), but{' '}
						<em>implement</em> tasks will fail at <code>git push</code> /{' '}
						<code>gh pr create</code> with a read-only or missing token. Read-only
						access is enough only if you exclusively run <em>review</em>,{' '}
						<em>respond</em>, or <em>summarize</em> tasks.
					</Typography>
				</Alert>
				<Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
					<TextField
						label="GitHub repository"
						placeholder="org/name"
						value={repo}
						onChange={(e) => setRepo(e.target.value)}
						required
						slotProps={{ htmlInput: { pattern: '[^/]+/[^/]+' } }}
						size="small"
						fullWidth
					/>
					<TextField
						label="Webhook secret"
						type="password"
						placeholder="Secret from GitHub webhook settings"
						value={secret}
						onChange={(e) => setSecret(e.target.value)}
						required
						size="small"
						fullWidth
					/>
					<TextField
						label="GitHub PAT (optional)"
						type="password"
						placeholder="Fine-grained personal access token"
						value={pat}
						onChange={(e) => setPat(e.target.value)}
						size="small"
						fullWidth
					/>
				</Stack>
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
					<Button type="submit" variant="contained" disabled={submitting}>
						{submitting ? 'Saving…' : 'Save'}
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
