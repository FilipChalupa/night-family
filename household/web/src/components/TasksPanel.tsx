import {
	Alert,
	Box,
	Button,
	Chip,
	Dialog,
	DialogContent,
	DialogTitle,
	IconButton,
	Link,
	MenuItem,
	Paper,
	Stack,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TablePagination,
	TableRow,
	TextField,
	Tooltip,
	Typography,
} from '@mui/material'
import HistoryIcon from '@mui/icons-material/History'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { TaskKind, TaskRecord, TaskStatus } from '../types.ts'

export interface PaginationControl {
	page: number
	pageSize: number
	onPageChange: (page: number) => void
	onPageSizeChange: (pageSize: number) => void
	rowsPerPageOptions?: number[]
}

interface Props {
	tasks: TaskRecord[]
	canManage: boolean
	onCreate: (input: {
		kind: TaskKind
		title: string
		description: string
		repo: string | null
	}) => Promise<void>
	onCancel: (id: string) => Promise<void>
	onRetry: (id: string) => Promise<void>
	pagination?: PaginationControl
	showCreateForm?: boolean
}

const KINDS: TaskKind[] = ['implement', 'review', 'respond', 'summarize', 'estimate']
const ACTIVE: ReadonlyArray<TaskStatus> = [
	'new',
	'estimating',
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
]

export function TasksPanel({
	tasks,
	canManage,
	onCreate,
	onCancel,
	onRetry,
	pagination,
	showCreateForm = true,
}: Props) {
	const visible = pagination
		? tasks.slice(
				pagination.page * pagination.pageSize,
				(pagination.page + 1) * pagination.pageSize,
			)
		: tasks

	return (
		<Stack spacing={2}>
			{showCreateForm ? (
				canManage ? (
					<NewTaskForm onCreate={onCreate} />
				) : (
					<Alert severity="info" variant="outlined">
						You can view tasks, but creating or cancelling tasks is admin-only.
					</Alert>
				)
			) : null}
			<TasksTable
				tasks={visible}
				canManage={canManage}
				onCancel={onCancel}
				onRetry={onRetry}
			/>
			{pagination ? (
				<TablePagination
					component="div"
					count={tasks.length}
					page={pagination.page}
					onPageChange={(_, p) => pagination.onPageChange(p)}
					rowsPerPage={pagination.pageSize}
					onRowsPerPageChange={(e) => {
						pagination.onPageSizeChange(parseInt(e.target.value, 10))
					}}
					rowsPerPageOptions={pagination.rowsPerPageOptions ?? [10, 25, 50, 100]}
				/>
			) : null}
		</Stack>
	)
}

function NewTaskForm({ onCreate }: { onCreate: Props['onCreate'] }) {
	const [kind, setKind] = useState<TaskKind>('implement')
	const [title, setTitle] = useState('')
	const [description, setDescription] = useState('')
	const [repo, setRepo] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			await onCreate({
				kind,
				title: title.trim(),
				description: description.trim(),
				repo: repo.trim() || null,
			})
			setTitle('')
			setDescription('')
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
						select
						label="Task type"
						value={kind}
						onChange={(e) => setKind(e.target.value as TaskKind)}
						size="small"
						sx={{ minWidth: 160 }}
					>
						{KINDS.map((k) => (
							<MenuItem key={k} value={k}>
								{k}
							</MenuItem>
						))}
					</TextField>
					<TextField
						label="Title"
						placeholder="Short task title"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						required
						slotProps={{ htmlInput: { maxLength: 200 } }}
						size="small"
						fullWidth
					/>
					<TextField
						label="Repository (optional)"
						placeholder="org/name"
						value={repo}
						onChange={(e) => setRepo(e.target.value)}
						size="small"
						fullWidth
					/>
				</Stack>
				<TextField
					label="Description"
					placeholder="What should the agent do?"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					multiline
					rows={3}
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
					<Button
						type="submit"
						variant="contained"
						disabled={submitting || !title.trim()}
					>
						{submitting ? 'Creating…' : 'Create task'}
					</Button>
				</Stack>
			</Stack>
		</Paper>
	)
}

function TasksTable({
	tasks,
	canManage,
	onCancel,
	onRetry,
}: {
	tasks: TaskRecord[]
	canManage: boolean
	onCancel: Props['onCancel']
	onRetry: Props['onRetry']
}) {
	const [eventsTaskId, setEventsTaskId] = useState<string | null>(null)
	const [retryingId, setRetryingId] = useState<string | null>(null)
	const [retryError, setRetryError] = useState<string | null>(null)
	const tokensByTask = useTaskTokens()
	if (tasks.length === 0) {
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
				No tasks yet.
			</Box>
		)
	}
	return (
		<TableContainer component={Paper} variant="outlined">
			<Table size="small">
				<TableHead>
					<TableRow>
						<TableCell>Title</TableCell>
						<TableCell>Kind</TableCell>
						<TableCell>Status</TableCell>
						<TableCell>Assigned</TableCell>
						<TableCell>Repo</TableCell>
						<TableCell>Estimate</TableCell>
						<TableCell align="right">Tokens</TableCell>
						<TableCell>Created</TableCell>
						<TableCell />
					</TableRow>
				</TableHead>
				<TableBody>
					{tasks.map((t) => (
						<TableRow key={t.id} hover>
							<TableCell>
								{(() => {
									const issue = githubIssueRef(t.metadata)
									return (
										<Stack
											direction="row"
											spacing={1}
											sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
										>
											{issue?.url ? (
												<Link
													href={issue.url}
													target="_blank"
													rel="noopener noreferrer"
													underline="hover"
													sx={{ fontWeight: 600 }}
												>
													{t.title}
												</Link>
											) : (
												<Typography sx={{ fontWeight: 600 }}>
													{t.title}
												</Typography>
											)}
											{issue?.number != null ? (
												<Typography
													variant="caption"
													color="text.secondary"
												>
													#{issue.number}
												</Typography>
											) : null}
										</Stack>
									)
								})()}
								{t.failureReason ? (
									<Typography variant="caption" color="error">
										✗ {t.failureReason}
									</Typography>
								) : null}
							</TableCell>
							<TableCell>
								<Typography variant="body2" color="text.secondary">
									{t.kind}
								</Typography>
							</TableCell>
							<TableCell>
								<Chip
									label={t.status}
									size="small"
									color={statusColor(t.status)}
									variant="outlined"
								/>
							</TableCell>
							<TableCell>
								<Typography variant="body2" color="text.secondary">
									{t.assignedMemberName ?? '—'}
								</Typography>
							</TableCell>
							<TableCell>
								{t.repo ? (
									<Link
										href={`https://github.com/${t.repo}`}
										target="_blank"
										rel="noopener noreferrer"
										underline="hover"
										variant="body2"
										color="text.secondary"
									>
										{t.repo}
									</Link>
								) : (
									<Typography variant="body2" color="text.secondary">
										—
									</Typography>
								)}
							</TableCell>
							<TableCell>
								{t.estimateSize ? (
									<Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
										<Tooltip title={estimateTooltip(t.estimateSize)}>
											<Chip
												label={t.estimateSize}
												size="small"
												color={estimateColor(t.estimateSize)}
												variant="filled"
												sx={{ fontWeight: 600, minWidth: 36 }}
											/>
										</Tooltip>
										{t.estimateBlockers && t.estimateBlockers.length > 0 ? (
											<Tooltip title={t.estimateBlockers.join('\n')}>
												<Typography
													variant="caption"
													color="text.secondary"
												>
													blockers: {t.estimateBlockers.length}
												</Typography>
											</Tooltip>
										) : null}
									</Stack>
								) : (
									<Typography variant="body2" color="text.secondary">
										—
									</Typography>
								)}
							</TableCell>
							<TableCell align="right">
								{(() => {
									const n = tokensByTask[t.id]
									if (!n) {
										return (
											<Typography variant="body2" color="text.secondary">
												—
											</Typography>
										)
									}
									return (
										<Tooltip title={n.toLocaleString()}>
											<Typography
												variant="body2"
												color="text.secondary"
												sx={{ fontVariantNumeric: 'tabular-nums' }}
											>
												{formatTokens(n)}
											</Typography>
										</Tooltip>
									)
								})()}
							</TableCell>
							<TableCell>
								<Tooltip title={t.createdAt}>
									<Typography variant="body2" color="text.secondary">
										{relativeTime(t.createdAt)}
									</Typography>
								</Tooltip>
							</TableCell>
							<TableCell align="right">
								<Stack
									direction="row"
									spacing={1}
									sx={{ justifyContent: 'flex-end', alignItems: 'center' }}
								>
									{(() => {
										const suspicious =
											(t.status === 'in-review' && !t.prUrl) ||
											(t.status === 'failed' &&
												t.failureReason === 'no_changes')
										const tooltip = suspicious
											? t.status === 'failed'
												? 'Failed with no_changes — agent claimed it finished but did not modify any files. Click to inspect events.'
												: 'Marked in-review but no PR was opened. Click to inspect events.'
											: 'Inspect events from this task.'
										return (
											<Tooltip title={tooltip}>
												<IconButton
													size="small"
													color={suspicious ? 'warning' : 'default'}
													onClick={() => setEventsTaskId(t.id)}
												>
													{suspicious ? (
														<WarningAmberIcon fontSize="small" />
													) : (
														<HistoryIcon fontSize="small" />
													)}
												</IconButton>
											</Tooltip>
										)
									})()}
									{canManage && ACTIVE.includes(t.status) ? (
										<Button
											size="small"
											variant="outlined"
											color="error"
											onClick={() => {
												void onCancel(t.id)
											}}
										>
											Cancel
										</Button>
									) : null}
									{canManage && t.status === 'failed' ? (
										<Tooltip
											title={
												t.failureReason
													? `Retry this task. Last failure: ${t.failureReason}`
													: 'Retry this task'
											}
										>
											<span>
												<Button
													size="small"
													variant="outlined"
													disabled={retryingId === t.id}
													onClick={async () => {
														setRetryingId(t.id)
														setRetryError(null)
														try {
															await onRetry(t.id)
														} catch (err) {
															setRetryError(
																err instanceof Error
																	? err.message
																	: String(err),
															)
														} finally {
															setRetryingId(null)
														}
													}}
												>
													{retryingId === t.id ? 'Retrying…' : 'Retry'}
												</Button>
											</span>
										</Tooltip>
									) : null}
								</Stack>
								{retryError && retryingId === null && t.status === 'failed' ? (
									<Typography
										variant="caption"
										color="error"
										sx={{ display: 'block', mt: 0.5 }}
									>
										{retryError}
									</Typography>
								) : null}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			<TaskEventsDialog taskId={eventsTaskId} onClose={() => setEventsTaskId(null)} />
		</TableContainer>
	)
}

interface TaskEvent {
	seq: number
	ts: string
	kind: string
	memberId: string | null
	payload: unknown
}

function TaskEventsDialog({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
	const { data: events, error } = useQuery<TaskEvent[]>({
		queryKey: ['task-events', taskId],
		queryFn: async () => {
			const r = await fetch(`/api/tasks/${taskId}/events?limit=50`)
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string }
				throw new Error(b.error ?? `HTTP ${r.status}`)
			}
			const body = (await r.json()) as { events: TaskEvent[] }
			return body.events
		},
		enabled: taskId !== null,
	})

	return (
		<Dialog open={taskId !== null} onClose={onClose} maxWidth="md" fullWidth>
			<DialogTitle>Task events</DialogTitle>
			<DialogContent>
				{error ? <Alert severity="error">{(error as Error).message}</Alert> : null}
				{!events && !error ? (
					<Typography color="text.secondary">Loading…</Typography>
				) : null}
				{events && events.length === 0 ? (
					<Typography color="text.secondary">
						No events recorded for this task. Either the agent never sent any (e.g. it
						crashed before emit) or they were purged after 90 days.
					</Typography>
				) : null}
				{events && events.length > 0 ? (
					<Stack spacing={1}>
						{events.map((e) => (
							<Box
								key={e.seq}
								sx={{
									p: 1.5,
									border: 1,
									borderColor: 'divider',
									borderRadius: 1,
									backgroundColor: 'background.default',
								}}
							>
								<Stack
									direction="row"
									spacing={1}
									sx={{ alignItems: 'baseline', mb: 0.5 }}
								>
									<Chip label={e.kind} size="small" variant="outlined" />
									<Typography variant="caption" color="text.secondary">
										seq {e.seq} · {new Date(e.ts).toLocaleString()}
									</Typography>
								</Stack>
								<Box
									component="pre"
									sx={{
										m: 0,
										fontFamily: 'monospace',
										fontSize: '0.78rem',
										whiteSpace: 'pre-wrap',
										wordBreak: 'break-word',
										color: 'text.secondary',
									}}
								>
									{JSON.stringify(e.payload, null, 2)}
								</Box>
							</Box>
						))}
					</Stack>
				) : null}
			</DialogContent>
		</Dialog>
	)
}

function estimateColor(size: 'S' | 'M' | 'L' | 'XL'): 'success' | 'info' | 'warning' | 'error' {
	switch (size) {
		case 'S':
			return 'success'
		case 'M':
			return 'info'
		case 'L':
			return 'warning'
		case 'XL':
			return 'error'
	}
}

function estimateTooltip(size: 'S' | 'M' | 'L' | 'XL'): string {
	switch (size) {
		case 'S':
			return 'Small — focused change in a single small file.'
		case 'M':
			return 'Medium — a few files, straightforward changes.'
		case 'L':
			return 'Large — multi-file refactor or non-trivial logic.'
		case 'XL':
			return 'Extra large — cross-cutting changes or significant new functionality.'
	}
}

function statusColor(status: TaskStatus): 'default' | 'info' | 'warning' | 'success' | 'error' {
	switch (status) {
		case 'new':
		case 'queued':
			return 'info'
		case 'estimating':
		case 'assigned':
		case 'in-progress':
		case 'in-review':
		case 'awaiting-merge':
			return 'warning'
		case 'done':
			return 'success'
		case 'failed':
		case 'disconnected':
			return 'error'
		default:
			return 'default'
	}
}

function githubIssueRef(
	metadata: Record<string, unknown> | null,
): { number: number | null; url: string | null } | null {
	if (!metadata) return null
	const numberRaw = metadata['github_issue_number']
	const urlRaw = metadata['github_issue_url']
	const number = typeof numberRaw === 'number' ? numberRaw : null
	const url = typeof urlRaw === 'string' ? urlRaw : null
	if (number === null && url === null) return null
	return { number, url }
}

function useTaskTokens(): Record<string, number> {
	const { data } = useQuery<Record<string, number>>({
		queryKey: ['task-tokens'],
		queryFn: async () => {
			const r = await fetch('/api/stats/task-tokens')
			if (!r.ok) return {}
			const b = (await r.json()) as { tokens: Record<string, number> }
			return b.tokens ?? {}
		},
		refetchInterval: 15_000,
	})
	return data ?? {}
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
	return value.toLocaleString()
}

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
	return `${Math.floor(ms / 3_600_000)}h ago`
}
