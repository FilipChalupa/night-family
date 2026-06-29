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
import { alpha } from '@mui/material/styles'
import HistoryIcon from '@mui/icons-material/History'
import HourglassTopIcon from '@mui/icons-material/HourglassTop'
import PersonIcon from '@mui/icons-material/Person'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { useQuery } from '@tanstack/react-query'
import { Link as RouterLink } from '@tanstack/react-router'
import { acceptableTaskKinds } from '@night/shared'
import { useState } from 'react'
import { useAppData } from '../AppContext.tsx'
import { formatTokens } from '../format.ts'
import { relativeTime } from '../time.ts'
import { TaskTimeline } from './TaskTimeline.tsx'
import {
	OPEN_STATUSES,
	isWaitingOnHuman,
	reviewWaitState,
	type MemberSnapshot,
	type ReviewJobsSummary,
	type TaskKind,
	type TaskRecord,
	type TaskStatus,
} from '../types.ts'

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
		metadata?: Record<string, unknown>
	}) => Promise<void>
	onCancel: (id: string) => Promise<void>
	onRetry: (id: string) => Promise<void>
	pagination?: PaginationControl
	showCreateForm?: boolean
}

// Filter order roughly mirrors the typical lifecycle: triage runs first,
// then implement, then rebase / review / respond. Summarize is standalone.
const KINDS: TaskKind[] = [
	'triage',
	'implement',
	'rebase',
	'review',
	'respond',
	'summarize',
	'preview',
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
			{canManage ? <BulkRetryBar tasks={tasks} onRetry={onRetry} /> : null}
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

/**
 * One-click retry of every `failed` task in the current view (the `tasks` prop
 * is already filtered by the page). Retries sequentially so a burst doesn't
 * hammer dispatch; surfaces the first error and how many succeeded.
 */
function BulkRetryBar({ tasks, onRetry }: { tasks: TaskRecord[]; onRetry: Props['onRetry'] }) {
	const failed = tasks.filter((t) => t.status === 'failed')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	if (failed.length === 0) return null

	const run = async () => {
		if (!window.confirm(`Retry ${failed.length} failed task(s)?`)) return
		setBusy(true)
		setError(null)
		let ok = 0
		for (const t of failed) {
			try {
				await onRetry(t.id)
				ok++
			} catch (e) {
				setError(`Stopped after ${ok}/${failed.length}: ${(e as Error).message}`)
				break
			}
		}
		setBusy(false)
	}

	return (
		<Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
			<Button size="small" variant="outlined" color="warning" onClick={run} disabled={busy}>
				{busy ? 'Retrying…' : `Retry all failed (${failed.length})`}
			</Button>
			{error ? (
				<Typography variant="caption" color="error">
					{error}
				</Typography>
			) : null}
		</Stack>
	)
}

function NewTaskForm({ onCreate }: { onCreate: Props['onCreate'] }) {
	const [kind, setKind] = useState<TaskKind>('implement')
	const [title, setTitle] = useState('')
	const [description, setDescription] = useState('')
	const [repo, setRepo] = useState('')
	const [branch, setBranch] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const isPreview = kind === 'preview'

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
				...(isPreview && branch.trim() ? { metadata: { branch: branch.trim() } } : {}),
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
						label={isPreview ? 'Repository' : 'Repository (optional)'}
						placeholder="org/name"
						value={repo}
						onChange={(e) => setRepo(e.target.value)}
						required={isPreview}
						size="small"
						fullWidth
					/>
					{isPreview ? (
						<TextField
							label="Branch to preview"
							placeholder="feature/my-branch"
							value={branch}
							onChange={(e) => setBranch(e.target.value)}
							required
							size="small"
							fullWidth
						/>
					) : null}
				</Stack>
				{isPreview ? (
					<Alert severity="info" variant="outlined">
						Checks out the branch, starts the project's dev server, and reports where
						it's live — also written into the branch's PR, if one is open. The preview
						stays up until the task is cancelled.
					</Alert>
				) : (
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
				)}
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
						disabled={
							submitting ||
							!title.trim() ||
							(isPreview && (!repo.trim() || !branch.trim()))
						}
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
	const { members } = useAppData()
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
						<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
							Kind
						</TableCell>
						<TableCell>Status</TableCell>
						<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
							Assigned
						</TableCell>
						<TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
							Repo
						</TableCell>
						<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
							Estimate
						</TableCell>
						<TableCell align="right" sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
							Tokens
						</TableCell>
						<TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
							Created
						</TableCell>
						<TableCell />
					</TableRow>
				</TableHead>
				<TableBody>
					{tasks.map((t) => (
						<TableRow
							key={t.id}
							hover
							sx={
								isWaitingOnHuman(t)
									? {
											// Waiting on a human (agent done reviewing, or
											// ready to merge) — accent the row so it doesn't
											// get lost. The status chip + ReviewWaitBadge carry
											// the same meaning textually for screen readers.
											borderLeft: 3,
											borderLeftColor: 'warning.main',
											'& > td': {
												bgcolor: (theme) =>
													alpha(theme.palette.warning.main, 0.08),
											},
										}
									: undefined
							}
						>
							<TableCell>
								{(() => {
									const issue = githubIssueRef(t)
									return (
										<Stack
											direction="row"
											spacing={1}
											sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
										>
											<RouterLink
												to="/tasks/$taskId"
												params={{ taskId: t.id }}
												style={{
													color: 'inherit',
													textDecoration: 'none',
													fontWeight: 600,
												}}
											>
												{t.title}
											</RouterLink>
											{issue?.url ? (
												<Link
													href={issue.url}
													target="_blank"
													rel="noopener noreferrer"
													underline="hover"
													variant="caption"
													color="text.secondary"
												>
													#{issue.number ?? 'issue'} ↗
												</Link>
											) : null}
										</Stack>
									)
								})()}
								{(() => {
									const state = previewState(t)
									if (state === 'ready') {
										const ports = previewPortsOf(t)
										return ports.map((p) => (
											<Box key={p.port}>
												<Link
													href={p.url}
													target="_blank"
													rel="noopener noreferrer"
													underline="hover"
													variant="caption"
													color="success.main"
												>
													▶ Preview{ports.length > 1 ? ` ${p.label}` : ''}{' '}
													↗
												</Link>
											</Box>
										))
									}
									if (state === 'starting' || state === 'queued') {
										return (
											<Typography variant="caption" color="text.secondary">
												⏳ Preview{' '}
												{state === 'queued' ? 'queued' : 'starting…'}
											</Typography>
										)
									}
									return null
								})()}
								{t.failureReason ? (
									<Typography variant="caption" color="error">
										✗ {t.failureReason}
									</Typography>
								) : null}
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
								<Typography variant="body2" color="text.secondary">
									{t.kind}
								</Typography>
							</TableCell>
							<TableCell>
								<Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
									<Chip
										label={t.status}
										size="small"
										color={statusColor(t.status)}
										variant="outlined"
									/>
									{t.status === 'in-review' ? (
										<ReviewWaitBadge jobs={t.reviewJobs} />
									) : null}
									{isQueueBlockedByRepo(t, members) ? (
										<QueueBlockedByRepoBadge repo={t.repo!} />
									) : null}
								</Stack>
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
								{t.assignedMemberId ? (
									<RouterLink
										to="/members/$memberId"
										params={{ memberId: t.assignedMemberId }}
										style={{
											color: 'inherit',
											textDecoration: 'underline',
											textDecorationStyle: 'dotted',
											fontSize: '0.875rem',
										}}
									>
										{t.assignedMemberName ?? t.assignedMemberId.slice(0, 8)}
									</RouterLink>
								) : (
									<Typography variant="body2" color="text.secondary">
										—
									</Typography>
								)}
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
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
							<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
								{t.planSize ? (
									<Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
										<Tooltip title={planSizeTooltip(t.planSize)}>
											<Chip
												label={t.planSize}
												size="small"
												color={planSizeColor(t.planSize)}
												variant="filled"
												sx={{ fontWeight: 600, minWidth: 36 }}
											/>
										</Tooltip>
										{t.planBlockers && t.planBlockers.length > 0 ? (
											<Tooltip title={t.planBlockers.join('\n')}>
												<Typography
													variant="caption"
													color="text.secondary"
												>
													blockers: {t.planBlockers.length}
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
							<TableCell
								align="right"
								sx={{ display: { xs: 'none', lg: 'table-cell' } }}
							>
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
							<TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
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
									{canManage && OPEN_STATUSES.includes(t.status) ? (
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

function TaskEventsDialog({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
	return (
		<Dialog open={taskId !== null} onClose={onClose} maxWidth="md" fullWidth>
			<DialogTitle>Task events</DialogTitle>
			<DialogContent>
				{taskId !== null ? <TaskTimeline taskId={taskId} limit={50} /> : null}
			</DialogContent>
		</Dialog>
	)
}

function planSizeColor(size: 'S' | 'M' | 'L' | 'XL'): 'success' | 'info' | 'warning' | 'error' {
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

function planSizeTooltip(size: 'S' | 'M' | 'L' | 'XL'): string {
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
		case 'queued':
			return 'info'
		case 'assigned':
		case 'in-progress':
		case 'in-review':
		case 'awaiting-merge':
			return 'warning'
		case 'done':
			return 'success'
		case 'failed':
			return 'error'
		default:
			return 'default'
	}
}

/**
 * Is this queued task stuck because no skill-matching, online member has the
 * repo in its allowlist? Returns false for non-queued tasks, repo-less tasks,
 * and when at least one matching member already covers the repo (the task is
 * just waiting for them to free up — that's normal queue behaviour, not a
 * stuck dispatch). Also returns false when no matching member has the skill
 * at all — that's a different kind of misconfiguration the chip would
 * incorrectly attribute to repo coverage.
 */
export function isQueueBlockedByRepo(task: TaskRecord, members: MemberSnapshot[]): boolean {
	if (task.status !== 'queued') return false
	if (!task.repo) return false
	const live = members.filter((m) => m.status !== 'offline')
	const skillMatched = live.filter((m) => acceptableTaskKinds(m.skills).includes(task.kind))
	if (skillMatched.length === 0) return false
	const repo = task.repo
	return !skillMatched.some((m) => m.repos === null || m.repos.includes(repo))
}

export function QueueBlockedByRepoBadge({ repo }: { repo: string }) {
	const [owner, name] = repo.split('/', 2)
	const chip = (
		<Chip
			icon={<WarningAmberIcon />}
			label="no member covers repo"
			size="small"
			color="warning"
			variant="filled"
			sx={{ fontWeight: 500 }}
		/>
	)
	const tooltip = `No online, skill-matching member has ${repo} in its allowlist. Dispatch is blocked until somebody refreshes or gains push access. Click to open the repo detail.`
	if (owner && name) {
		return (
			<Tooltip title={tooltip}>
				<RouterLink
					to="/repos/$owner/$name"
					params={{ owner, name }}
					style={{ textDecoration: 'none' }}
				>
					{chip}
				</RouterLink>
			</Tooltip>
		)
	}
	return <Tooltip title={tooltip}>{chip}</Tooltip>
}

/**
 * Sub-label shown beneath the `in-review` status chip explaining whether the
 * task is waiting on an agent's review or on a human (approve / merge /
 * push fixups). Tooltip includes the raw job counts so admins can sanity-check.
 */
export function ReviewWaitBadge({ jobs }: { jobs: ReviewJobsSummary | null }) {
	const state = reviewWaitState(jobs)
	if (state === 'unknown') return null

	const open = (jobs?.pending ?? 0) + (jobs?.inProgress ?? 0)
	const total =
		(jobs?.pending ?? 0) +
		(jobs?.inProgress ?? 0) +
		(jobs?.completed ?? 0) +
		(jobs?.failed ?? 0)

	if (state === 'agent') {
		return (
			<Tooltip
				title={`Agent reviewing — ${open} of ${total} review job${total === 1 ? '' : 's'} still open.`}
			>
				<Chip
					icon={<HourglassTopIcon />}
					label={total > 1 ? `agent reviewing (${open}/${total})` : 'agent reviewing'}
					size="small"
					color="warning"
					variant="filled"
					sx={{ fontWeight: 500 }}
				/>
			</Tooltip>
		)
	}

	const completed = jobs?.completed ?? 0
	const failed = jobs?.failed ?? 0
	return (
		<Tooltip
			title={`Agent reviews finished (${completed} completed${failed > 0 ? `, ${failed} failed` : ''}). Waiting for a human to approve, push fixups, or merge.`}
		>
			<Chip
				icon={<PersonIcon />}
				label="waiting for human"
				size="small"
				color="info"
				variant="filled"
				sx={{ fontWeight: 500 }}
			/>
		</Tooltip>
	)
}

function githubIssueRef(task: TaskRecord): { number: number | null; url: string | null } | null {
	if (task.githubIssueNumber === null && task.githubIssueUrl === null) return null
	return { number: task.githubIssueNumber, url: task.githubIssueUrl }
}

export interface PreviewPortLink {
	port: number
	label: string
	url: string
}

/**
 * Exposed preview ports, stashed in task metadata by the Member's `preview
 * ready` event. A preview can expose several (web + api …); today it's usually
 * one. Only meaningful while the task is active — a stopped preview keeps the
 * key but the URLs are no longer reachable, so callers gate on task status.
 */
export function previewPortsOf(task: TaskRecord): PreviewPortLink[] {
	const raw = task.metadata?.['preview_ports']
	if (!Array.isArray(raw)) return []
	return raw.flatMap((p): PreviewPortLink[] => {
		if (!p || typeof p !== 'object') return []
		const e = p as Record<string, unknown>
		if (typeof e['url'] !== 'string') return []
		return [
			{
				port: typeof e['port'] === 'number' ? e['port'] : 0,
				label: typeof e['label'] === 'string' ? e['label'] : 'app',
				url: e['url'],
			},
		]
	})
}

export type PreviewUiState = 'queued' | 'starting' | 'ready' | 'failed' | 'ended'

/**
 * Lifecycle state of a `preview` task for the dashboard. `null` for non-preview
 * tasks. `starting` = claimed but hasn't reported its URL(s) yet (checkout /
 * install / boot); `ready` = links are live.
 */
export function previewState(task: TaskRecord): PreviewUiState | null {
	if (task.kind !== 'preview') return null
	switch (task.status) {
		case 'failed':
			return 'failed'
		case 'done':
			return 'ended'
		case 'queued':
			return 'queued'
		default:
			return previewPortsOf(task).length > 0 ? 'ready' : 'starting'
	}
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
