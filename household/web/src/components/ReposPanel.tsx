import {
	Alert,
	Box,
	Button,
	IconButton,
	Paper,
	Stack,
	Step,
	StepLabel,
	Stepper,
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
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { EmptyState } from '../routes/Root.tsx'
import { useConfirm } from './ConfirmDialog.tsx'

interface RepoBinding {
	repo: string
	createdAt: string
	updatedAt: string
}

interface RepoDraft {
	repo: string
	webhook_secret: string
	payload_url: string
	hooks_settings_url: string
}

export function ReposPanel({ canManage }: { canManage: boolean }) {
	const queryClient = useQueryClient()
	const [showWizard, setShowWizard] = useState(false)
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

	if (reposQuery.isLoading) return <EmptyState>Loading repos…</EmptyState>
	if (reposQuery.error)
		return <Alert severity="error">{(reposQuery.error as Error).message}</Alert>
	const repos = reposQuery.data ?? []

	return (
		<Stack spacing={2}>
			{canManage ? (
				showWizard ? (
					<RepoWizard
						onCreated={() => {
							setShowWizard(false)
							refresh()
						}}
						onCancel={() => setShowWizard(false)}
					/>
				) : (
					<Box>
						<Button
							variant="outlined"
							size="small"
							startIcon={<AddIcon />}
							onClick={() => setShowWizard(true)}
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
				<EmptyState>
					No repo bindings yet. Add one to enable issue import + PR tracking.
				</EmptyState>
			) : (
				<TableContainer component={Paper} variant="outlined">
					<Table size="small">
						<TableHead>
							<TableRow>
								<TableCell>Repo</TableCell>
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

function RepoWizard({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
	const [step, setStep] = useState<0 | 1>(0)
	const [repo, setRepo] = useState('')
	const [draft, setDraft] = useState<RepoDraft | null>(null)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const requestDraft = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault()
		setError(null)
		setPending(true)
		try {
			const res = await fetch('/api/repos/draft', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ repo: repo.trim() }),
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				throw new Error(body.error ?? `HTTP ${res.status}`)
			}
			const d = (await res.json()) as RepoDraft
			setDraft(d)
			setStep(1)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setPending(false)
		}
	}

	const finalize = async () => {
		if (!draft) return
		setError(null)
		setPending(true)
		try {
			const res = await fetch('/api/repos', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ repo: draft.repo, webhook_secret: draft.webhook_secret }),
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				throw new Error(body.error ?? `HTTP ${res.status}`)
			}
			onCreated()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setPending(false)
		}
	}

	return (
		<Paper variant="outlined" sx={{ p: 2 }}>
			<Stack spacing={2}>
				<Stepper activeStep={step}>
					<Step>
						<StepLabel>Repository</StepLabel>
					</Step>
					<Step>
						<StepLabel>Configure GitHub webhook</StepLabel>
					</Step>
				</Stepper>

				{step === 0 ? (
					<form onSubmit={requestDraft}>
						<Stack spacing={2}>
							<Typography variant="body2" color="text.secondary">
								Enter the repository in <code>org/name</code> form. After this we'll
								generate a webhook secret and walk you through adding it on GitHub.
							</Typography>
							<TextField
								label="GitHub repository"
								placeholder="org/name"
								value={repo}
								onChange={(e) => setRepo(e.target.value)}
								required
								slotProps={{ htmlInput: { pattern: '[^/]+/[^/]+' } }}
								size="small"
								autoFocus
							/>
							<Stack
								direction="row"
								spacing={2}
								sx={{ justifyContent: 'flex-end', alignItems: 'center' }}
							>
								{error ? (
									<Typography color="error" variant="body2" sx={{ mr: 'auto' }}>
										{error}
									</Typography>
								) : null}
								<Button variant="outlined" onClick={onCancel} disabled={pending}>
									Cancel
								</Button>
								<Button type="submit" variant="contained" disabled={pending}>
									{pending ? 'Generating…' : 'Next'}
								</Button>
							</Stack>
						</Stack>
					</form>
				) : draft ? (
					<Stack spacing={2}>
						<Alert severity="warning" variant="outlined">
							The webhook secret below is shown once. Copy it before confirming —
							you'll need it on GitHub, and re-adding the binding will rotate it.
						</Alert>
						<CopyField label="Payload URL" value={draft.payload_url} />
						<CopyField label="Webhook secret" value={draft.webhook_secret} secret />
						<Box>
							<Button
								variant="outlined"
								size="small"
								endIcon={<OpenInNewIcon />}
								href={draft.hooks_settings_url}
								target="_blank"
								rel="noreferrer noopener"
							>
								Open GitHub webhook settings
							</Button>
						</Box>
						<Typography variant="body2" color="text.secondary">
							In GitHub: paste the payload URL, paste the secret, set <em>Content
							type</em> to <code>application/json</code>, and select these events —
							<em> Issues</em>, <em>Issue comments</em>, <em>Pull requests</em>,
							<em> Pull request reviews</em>. Save the webhook, then come back and
							confirm.
						</Typography>
						<Stack
							direction="row"
							spacing={2}
							sx={{ justifyContent: 'flex-end', alignItems: 'center' }}
						>
							{error ? (
								<Typography color="error" variant="body2" sx={{ mr: 'auto' }}>
									{error}
								</Typography>
							) : null}
							<Button variant="outlined" onClick={onCancel} disabled={pending}>
								Cancel
							</Button>
							<Button
								variant="contained"
								disabled={pending}
								onClick={() => {
									void finalize()
								}}
							>
								{pending ? 'Saving…' : "I've added the webhook"}
							</Button>
						</Stack>
					</Stack>
				) : null}
			</Stack>
		</Paper>
	)
}

function CopyField({
	label,
	value,
	secret,
}: {
	label: string
	value: string
	secret?: boolean
}) {
	const [copied, setCopied] = useState(false)
	const copy = async () => {
		await navigator.clipboard.writeText(value)
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}
	return (
		<TextField
			label={label}
			value={value}
			type={secret ? 'password' : 'text'}
			size="small"
			fullWidth
			slotProps={{
				input: {
					readOnly: true,
					endAdornment: (
						<Tooltip title={copied ? 'Copied' : 'Copy'}>
							<IconButton
								size="small"
								onClick={() => {
									void copy()
								}}
							>
								<ContentCopyIcon fontSize="small" />
							</IconButton>
						</Tooltip>
					),
				},
			}}
		/>
	)
}
