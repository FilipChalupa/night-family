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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useConfirm } from './ConfirmDialog.tsx'

interface RepoBinding {
	repo: string
	hasPat: boolean
	createdAt: string
	updatedAt: string
}

export function ReposPanel({ canManage }: { canManage: boolean }) {
	const queryClient = useQueryClient()
	const [showForm, setShowForm] = useState(false)
	const confirm = useConfirm()

	const reposQuery = useQuery<RepoBinding[]>({
		queryKey: ['repos'],
		queryFn: async () => {
			const r = await fetch('/api/repos')
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			const body = (await r.json()) as { repos: RepoBinding[] }
			return body.repos
		},
	})

	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ['repos'] })
	}

	const removeMutation = useMutation({
		mutationFn: async (repo: string) => {
			await fetch(`/api/repos/${encodeURIComponent(repo)}`, { method: 'DELETE' })
		},
		onSuccess: refresh,
	})

	const remove = async (repo: string) => {
		const ok = await confirm({
			title: 'Remove repo binding',
			description: (
				<>
					Remove the binding for <strong>{repo}</strong>? Tasks for this repo can no
					longer dispatch until you re-add it.
				</>
			),
			confirmLabel: 'Remove',
			confirmColor: 'error',
		})
		if (!ok) return
		removeMutation.mutate(repo)
	}

	if (reposQuery.isLoading) return <EmptyBox>Loading repos…</EmptyBox>
	if (reposQuery.error)
		return <Alert severity="error">{(reposQuery.error as Error).message}</Alert>
	const repos = reposQuery.data ?? []

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

	const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
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
						. Pick this repository and grant the following{' '}
						<strong>Repository permissions</strong>:
					</Typography>
					<Typography variant="body2" component="ul" sx={{ my: 0, pl: 3 }}>
						<li>
							<strong>Contents: Read and write</strong> — Members push commits to task
							branches.
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
						The PAT is required: without it Members cannot <code>git push</code> commits
						or open pull requests, and <em>implement</em> tasks will fail.
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
						label="GitHub PAT"
						type="password"
						placeholder="Fine-grained personal access token"
						value={pat}
						onChange={(e) => setPat(e.target.value)}
						required
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
