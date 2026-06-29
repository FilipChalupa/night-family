import { Alert, Box, Button, Chip, Link as MuiLink, Paper, Stack, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useAppData } from '../AppContext.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { previewPortsOf, previewState, ReviewWaitBadge } from '../components/TasksPanel.tsx'
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
	const { tasks, isAdmin, cancelTask, retryTask, createTask } = useAppData()

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
	const [busy, setBusy] = useState<'cancel' | 'retry' | 'restart' | null>(null)
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
	// Restart a finished/failed preview by enqueuing a fresh preview task for the
	// same branch (the original task is immutable once it's `done`).
	const handleRestart = async () => {
		if (!task) return
		const branch = previewBranchOf(task)
		if (!branch) return
		setBusy('restart')
		setActionError(null)
		try {
			await createTask({
				kind: 'preview',
				title: task.title,
				description: '',
				repo: task.repo,
				metadata: { branch },
			})
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
							onRestart={handleRestart}
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
	onRestart,
	actionError,
}: {
	task: TaskRecord
	canManage: boolean
	busy: 'cancel' | 'retry' | 'restart' | null
	onCancel: () => void
	onRetry: () => void
	onRestart: () => void
	actionError: string | null
}) {
	const cancellable = ACTIVE_STATUSES.has(task.status)
	const retryable = task.status === 'failed'
	// A finished/failed preview can be spun up again for the same branch.
	const restartable = task.kind === 'preview' && !cancellable && !!previewBranchOf(task)
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
					{task.status === 'in-review' ? (
						<ReviewWaitBadge jobs={task.reviewJobs} />
					) : null}
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
					label="Issue"
					value={
						task.githubIssueUrl ? (
							<MuiLink
								href={task.githubIssueUrl}
								target="_blank"
								rel="noopener noreferrer"
								underline="hover"
							>
								{task.githubIssueNumber
									? `#${task.githubIssueNumber}`
									: task.githubIssueUrl}
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
				{(() => {
					const ports = ACTIVE_STATUSES.has(task.status) ? previewPortsOf(task) : []
					return ports.length > 0 ? (
						<Field
							label="Preview"
							value={
								<Stack spacing={0.5}>
									{ports.map((p) => (
										<MuiLink
											key={p.port}
											href={p.url}
											target="_blank"
											rel="noopener noreferrer"
											underline="hover"
										>
											▶ {ports.length > 1 ? `${p.label}: ` : ''}
											{p.url}
										</MuiLink>
									))}
								</Stack>
							}
						/>
					) : null
				})()}
				{(() => {
					const state = previewState(task)
					return state === 'starting' || state === 'queued' ? (
						<Field
							label="Preview"
							value={`⏳ ${state === 'queued' ? 'queued — waiting for a member' : 'starting — checking out, installing, booting…'}`}
						/>
					) : null
				})()}
				<Field label="Plan size" value={planLabel(task)} />
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
						<Markdown>{task.description}</Markdown>
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

				{canManage && (cancellable || retryable || restartable) ? (
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
						{restartable ? (
							<Button
								variant="outlined"
								disabled={busy === 'restart'}
								onClick={onRestart}
							>
								{busy === 'restart' ? 'Restarting…' : 'Restart preview'}
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
	const first = new Date(events[0]!.ts).getTime()
	const last = new Date(events[events.length - 1]!.ts).getTime()
	const totalTokens = events.reduce((max, e) => {
		if (e.kind !== 'usage') return max
		const p = (e.payload ?? {}) as Record<string, unknown>
		return Math.max(max, num(p.input) + num(p.output))
	}, 0)

	return (
		<Stack spacing={1}>
			<Stack
				direction="row"
				spacing={1}
				sx={{ flexWrap: 'wrap', alignItems: 'baseline', mb: 0.5 }}
			>
				<Typography variant="body2" color="text.secondary">
					{events.length} events
				</Typography>
				{last > first ? (
					<Typography variant="body2" color="text.secondary">
						· {fmtDuration((last - first) / 1000)} elapsed
					</Typography>
				) : null}
				{totalTokens > 0 ? (
					<Typography variant="body2" color="text.secondary">
						· {fmtTokens(totalTokens)} tokens
					</Typography>
				) : null}
			</Stack>

			{events.map((e, i) => {
				const prevTs = i > 0 ? new Date(events[i - 1]!.ts).getTime() : null
				const deltaS = prevTs !== null ? (new Date(e.ts).getTime() - prevTs) / 1000 : null
				const { summary, tone } = summarizeEvent(e)
				const meta = kindMeta(e.kind)
				return (
					<Box
						key={e.seq}
						sx={{
							p: 1.25,
							border: 1,
							borderColor: 'divider',
							borderLeft: 3,
							borderLeftColor: `${meta.color}.main`,
							borderRadius: 1,
							backgroundColor: 'background.default',
						}}
					>
						<Stack
							direction="row"
							spacing={1}
							sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
						>
							<Chip
								label={meta.label}
								size="small"
								color={meta.color}
								variant="outlined"
							/>
							<Typography
								variant="body2"
								sx={{ wordBreak: 'break-word', flex: 1, minWidth: 0 }}
								color={tone === 'error' ? 'error' : 'text.primary'}
							>
								{summary}
							</Typography>
							<Typography variant="caption" color="text.secondary">
								{new Date(e.ts).toLocaleTimeString()}
								{deltaS !== null && deltaS >= 1 ? ` · +${fmtDuration(deltaS)}` : ''}
							</Typography>
						</Stack>
						<Box
							component="details"
							sx={{
								mt: 0.5,
								'& summary': {
									cursor: 'pointer',
									fontSize: '0.72rem',
									color: 'text.disabled',
									listStyle: 'none',
								},
							}}
						>
							<Box component="summary">raw · seq {e.seq}</Box>
							<Box
								component="pre"
								sx={{
									m: 0,
									mt: 0.5,
									fontFamily: 'monospace',
									fontSize: '0.74rem',
									whiteSpace: 'pre-wrap',
									wordBreak: 'break-word',
									color: 'text.secondary',
								}}
							>
								{JSON.stringify(e.payload, null, 2)}
							</Box>
						</Box>
					</Box>
				)
			})}
		</Stack>
	)
}

type ChipColor = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'info'

/** Per-kind label + accent colour for the timeline. */
function kindMeta(kind: string): { label: string; color: ChipColor } {
	switch (kind) {
		case 'tool_call':
			return { label: 'tool', color: 'info' }
		case 'file_edited':
			return { label: 'edit', color: 'secondary' }
		case 'commit':
			return { label: 'commit', color: 'success' }
		case 'usage':
			return { label: 'tokens', color: 'default' }
		case 'rebase':
			return { label: 'rebase', color: 'warning' }
		case 'preview':
			return { label: 'preview', color: 'primary' }
		case 'log':
			return { label: 'log', color: 'default' }
		default:
			return { label: kind, color: 'default' }
	}
}

/** A one-line human summary of an event payload. */
function summarizeEvent(e: TaskEvent): { summary: string; tone?: 'error' } {
	const p = (e.payload ?? {}) as Record<string, unknown>
	switch (e.kind) {
		case 'tool_call': {
			const tool = str(p.tool) || 'tool'
			const arg = argPreview(p.input)
			return { summary: arg ? `${tool}(${arg})` : tool }
		}
		case 'log': {
			if (typeof p.message === 'string') {
				return {
					summary: p.message,
					...(p.isError === true ? { tone: 'error' as const } : {}),
				}
			}
			if (typeof p.tool === 'string') {
				const out = str(p.output)
				return {
					summary: out ? `${p.tool} → ${truncate(out, 140)}` : String(p.tool),
					...(p.isError === true ? { tone: 'error' as const } : {}),
				}
			}
			return { summary: truncate(oneLineJson(p), 160) }
		}
		case 'usage': {
			const cache = num(p.cacheRead) + num(p.cacheCreation)
			const extra = cache > 0 ? ` · ${fmtTokens(cache)} cache` : ''
			return {
				summary: `${fmtTokens(num(p.input))} in · ${fmtTokens(num(p.output))} out${extra}`,
			}
		}
		case 'commit':
			return { summary: `${str(p.sha).slice(0, 7) || '?'} on ${str(p.branch) || '?'}` }
		case 'file_edited':
			return { summary: str(p.path) || oneLineJson(p) }
		case 'rebase':
			return { summary: str(p.outcome) || truncate(oneLineJson(p), 160) }
		case 'preview':
			return { summary: str(p.status) || str(p.url) || truncate(oneLineJson(p), 160) }
		default:
			return { summary: truncate(oneLineJson(p), 160) }
	}
}

/** Short preview of a tool's most salient arg (command / path / url). */
function argPreview(input: unknown): string {
	if (!input || typeof input !== 'object') return ''
	const o = input as Record<string, unknown>
	const salient = o.command ?? o.path ?? o.pr_url ?? o.issue_url ?? o.query
	if (typeof salient === 'string') return truncate(salient, 80)
	return truncate(oneLineJson(o), 80)
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : ''
}
function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + '…' : s
}
function oneLineJson(v: unknown): string {
	try {
		return JSON.stringify(v) ?? ''
	} catch {
		return String(v)
	}
}
function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
	return String(n)
}
function fmtDuration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
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

/** Branch a preview task targets, from its metadata. */
function previewBranchOf(task: TaskRecord): string | null {
	const b = task.metadata?.['branch']
	return typeof b === 'string' && b.length > 0 ? b : null
}

function planLabel(task: TaskRecord): string {
	if (!task.planSize) return '—'
	const blockers =
		task.planBlockers && task.planBlockers.length > 0
			? ` · blockers: ${task.planBlockers.join(', ')}`
			: ''
	return `${task.planSize}${blockers}`
}

const ACTIVE_STATUSES = new Set<TaskStatus>([
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
])

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
