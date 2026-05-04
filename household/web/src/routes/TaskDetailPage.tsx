import { Alert, Box, Button, Chip, Link as MuiLink, Paper, Stack, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useAppData } from '../AppContext.tsx'
import { ReviewWaitBadge } from '../components/TasksPanel.tsx'
import { taskDetailRoute } from '../router.tsx'
import { relativeTime } from '../time.ts'
import type { TaskRecord, TaskStatus } from '../types.ts'
import { EmptyState, Section } from './Root.tsx'

interface TaskEvent {
	seq: number
	ts: string
	kind: string
	memberId: string | null
	payload: unknown
}

export function TaskDetailPage() {
	const { taskId } = taskDetailRoute.useParams()
	const { tasks, isAdmin, cancelTask, retryTask } = useAppData()

	const fromStream = tasks.find((t) => t.id === taskId) ?? null
	// Tasks aren't time-windowed in the UI snapshot today, so the fallback fetch
	// is mostly a safety net for direct-link visits before the WS connects.
	const { data: fetched, error: fetchError } = useQuery<TaskRecord | null>({
		queryKey: ['task', taskId],
		queryFn: async () => {
			const r = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`)
			if (r.status === 404) return null
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			const body = (await r.json()) as { task: TaskRecord }
			return body.task
		},
		enabled: fromStream === null,
	})
	const task = fromStream ?? fetched ?? null

	const [actionError, setActionError] = useState<string | null>(null)
	const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null)
	const handleCancel = async () => {
		if (!task) return
		setBusy('cancel')
		setActionError(null)
		try {
			await cancelTask(task.id)
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(null)
		}
	}
	const handleRetry = async () => {
		if (!task) return
		setBusy('retry')
		setActionError(null)
		try {
			await retryTask(task.id)
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(null)
		}
	}

	return (
		<>
			<Box sx={{ mb: 2 }}>
				<Link
					to="/"
					style={{
						color: 'inherit',
						textDecoration: 'none',
						display: 'inline-flex',
						alignItems: 'center',
						gap: 6,
						fontSize: '0.875rem',
					}}
				>
					<ArrowBackIcon fontSize="small" />
					Back to dashboard
				</Link>
			</Box>

			{!task ? (
				fetchError ? (
					<Alert severity="error">
						Failed to load task: {(fetchError as Error).message}
					</Alert>
				) : fromStream === null && fetched === null ? (
					<EmptyState>Task not found.</EmptyState>
				) : (
					<EmptyState>Loading task…</EmptyState>
				)
			) : (
				<>
					<Section title="Task">
						<TaskDetailCard
							task={task}
							canManage={isAdmin}
							busy={busy}
							onCancel={handleCancel}
							onRetry={handleRetry}
							actionError={actionError}
						/>
					</Section>
					<Section title="Events">
						<TaskEventsList taskId={task.id} />
					</Section>
				</>
			)}
		</>
	)
}

function TaskDetailCard({
	task,
	canManage,
	busy,
	onCancel,
	onRetry,
	actionError,
}: {
	task: TaskRecord
	canManage: boolean
	busy: 'cancel' | 'retry' | null
	onCancel: () => void
	onRetry: () => void
	actionError: string | null
}) {
	const cancellable = ACTIVE_STATUSES.has(task.status)
	const retryable = task.status === 'failed'
	return (
		<Paper variant="outlined" sx={{ p: 2 }}>
			<Stack spacing={2}>
				<Stack
					direction="row"
					spacing={1.5}
					sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
				>
					<Typography variant="h6" sx={{ fontWeight: 600 }}>
						{task.title}
					</Typography>
					<Chip
						label={task.status}
						size="small"
						color={statusColor(task.status)}
						variant="outlined"
					/>
					<Chip label={task.kind} size="small" variant="outlined" />
					{task.status === 'in-review' ? <ReviewWaitBadge jobs={task.reviewJobs} /> : null}
				</Stack>

				{task.failureReason ? (
					<Alert severity="error" variant="outlined">
						{task.failureReason}
					</Alert>
				) : null}

				<Field label="Task ID" value={task.id} mono />
				<Field
					label="Repo"
					value={
						task.repo ? (
							<MuiLink
								href={`https://github.com/${task.repo}`}
								target="_blank"
								rel="noopener noreferrer"
								underline="hover"
							>
								{task.repo}
							</MuiLink>
						) : (
							'—'
						)
					}
				/>
				<Field
					label="Assigned to"
					value={
						task.assignedMemberId ? (
							<Link
								to="/members/$memberId"
								params={{ memberId: task.assignedMemberId }}
								style={{ color: 'inherit' }}
							>
								{task.assignedMemberName ?? task.assignedMemberId}
							</Link>
						) : (
							'—'
						)
					}
				/>
				<Field
					label="PR"
					value={
						task.prUrl ? (
							<MuiLink
								href={task.prUrl}
								target="_blank"
								rel="noopener noreferrer"
								underline="hover"
							>
								{task.prUrl}
							</MuiLink>
						) : (
							'—'
						)
					}
				/>
				<Field label="Estimate" value={estimateLabel(task)} />
				<Field label="Retries" value={String(task.retryCount)} />
				<Field
					label="Created"
					value={`${relativeTime(task.createdAt)} (${task.createdAt})`}
				/>
				<Field
					label="Updated"
					value={`${relativeTime(task.updatedAt)} (${task.updatedAt})`}
				/>

				{task.description ? (
					<Box>
						<Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
							Description
						</Typography>
						<Typography
							variant="body2"
							component="pre"
							sx={{
								fontFamily: 'inherit',
								whiteSpace: 'pre-wrap',
								wordBreak: 'break-word',
								m: 0,
							}}
						>
							{task.description}
						</Typography>
					</Box>
				) : null}

				{task.metadata && Object.keys(task.metadata).length > 0 ? (
					<Box>
						<Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
							Metadata
						</Typography>
						<Box
							component="pre"
							sx={{
								m: 0,
								p: 1.5,
								fontFamily: 'monospace',
								fontSize: '0.78rem',
								whiteSpace: 'pre-wrap',
								wordBreak: 'break-word',
								backgroundColor: 'background.default',
								border: 1,
								borderColor: 'divider',
								borderRadius: 1,
							}}
						>
							{JSON.stringify(task.metadata, null, 2)}
						</Box>
					</Box>
				) : null}

				{canManage && (cancellable || retryable) ? (
					<Stack direction="row" spacing={1}>
						{cancellable ? (
							<Button
								variant="outlined"
								color="error"
								disabled={busy === 'cancel'}
								onClick={onCancel}
							>
								{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
							</Button>
						) : null}
						{retryable ? (
							<Button
								variant="outlined"
								disabled={busy === 'retry'}
								onClick={onRetry}
							>
								{busy === 'retry' ? 'Retrying…' : 'Retry'}
							</Button>
						) : null}
					</Stack>
				) : null}
				{actionError ? (
					<Typography variant="caption" color="error">
						{actionError}
					</Typography>
				) : null}
			</Stack>
		</Paper>
	)
}

function TaskEventsList({ taskId }: { taskId: string }) {
	const { data: events, error } = useQuery<TaskEvent[]>({
		queryKey: ['task-events', taskId],
		queryFn: async () => {
			const r = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/events?limit=200`)
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string }
				throw new Error(b.error ?? `HTTP ${r.status}`)
			}
			const body = (await r.json()) as { events: TaskEvent[] }
			return body.events
		},
	})

	if (error) return <Alert severity="error">{(error as Error).message}</Alert>
	if (!events) return <EmptyState>Loading events…</EmptyState>
	if (events.length === 0) {
		return (
			<EmptyState>
				No events recorded for this task. Either the agent never sent any (e.g. it crashed
				before emit) or they were purged after 90 days.
			</EmptyState>
		)
	}
	return (
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
					<Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 0.5 }}>
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
	)
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
	return (
		<Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.25, sm: 2 }}>
			<Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
				{label}
			</Typography>
			<Typography
				variant="body2"
				component="div"
				sx={{
					fontFamily: mono ? 'monospace' : undefined,
					wordBreak: 'break-all',
				}}
			>
				{value}
			</Typography>
		</Stack>
	)
}

function estimateLabel(task: TaskRecord): string {
	if (!task.estimateSize) return '—'
	const blockers =
		task.estimateBlockers && task.estimateBlockers.length > 0
			? ` · blockers: ${task.estimateBlockers.join(', ')}`
			: ''
	return `${task.estimateSize}${blockers}`
}

const ACTIVE_STATUSES = new Set<TaskStatus>([
	'new',
	'estimating',
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
])

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
