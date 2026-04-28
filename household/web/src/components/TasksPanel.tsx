import {
	Alert,
	Box,
	Button,
	Chip,
	Dialog,
	DialogContent,
	DialogTitle,
	IconButton,
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
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { useEffect, useState } from 'react'
import type { TaskKind, TaskRecord, TaskStatus } from '../types.ts'

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

export function TasksPanel({ tasks, canManage, onCreate, onCancel }: Props) {
	return (
		<Stack spacing={2}>
			{canManage ? (
				<NewTaskForm onCreate={onCreate} />
			) : (
				<Alert severity="info" variant="outlined">
					You can view tasks, but creating or cancelling tasks is admin-only.
				</Alert>
			)}
			<TasksTable tasks={tasks} canManage={canManage} onCancel={onCancel} />
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
}: {
	tasks: TaskRecord[]
	canManage: boolean
	onCancel: Props['onCancel']
}) {
	const [eventsTaskId, setEventsTaskId] = useState<string | null>(null)
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
						<TableCell>Created</TableCell>
						<TableCell />
					</TableRow>
				</TableHead>
				<TableBody>
					{tasks.map((t) => (
						<TableRow key={t.id} hover>
							<TableCell>
								<Typography sx={{ fontWeight: 600 }}>{t.title}</Typography>
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
								<Typography variant="body2" color="text.secondary">
									{t.repo ?? '—'}
								</Typography>
							</TableCell>
							<TableCell>
								{t.estimateSize ? (
									<Stack spacing={0.5} sx={{ alignItems: 'flex-start' }}>
										<Chip
											label={t.estimateSize}
											size="small"
											color={estimateColor(t.estimateSize)}
											variant="filled"
											sx={{ fontWeight: 600, minWidth: 36 }}
										/>
										{t.estimateBlockers && t.estimateBlockers.length > 0 ? (
											<Typography variant="caption" color="text.secondary">
												blockers: {t.estimateBlockers.length}
											</Typography>
										) : null}
									</Stack>
								) : (
									<Typography variant="body2" color="text.secondary">
										—
									</Typography>
								)}
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
									{t.status === 'in-review' && !t.prUrl ? (
										<Tooltip title="Marked in-review but no PR was opened. Click to inspect events from the agent run.">
											<IconButton
												size="small"
												color="warning"
												onClick={() => setEventsTaskId(t.id)}
											>
												<WarningAmberIcon fontSize="small" />
											</IconButton>
										</Tooltip>
									) : null}
									{canManage && ACTIVE.includes(t.status) ? (
										<Button
											size="small"
											variant="outlined"
											onClick={() => {
												void onCancel(t.id)
											}}
										>
											Cancel
										</Button>
									) : null}
								</Stack>
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
	const [events, setEvents] = useState<TaskEvent[] | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!taskId) {
			setEvents(null)
			setError(null)
			return
		}
		setEvents(null)
		setError(null)
		void fetch(`/api/tasks/${taskId}/events?limit=50`)
			.then(async (r) => {
				if (!r.ok) {
					const b = (await r.json().catch(() => ({}))) as { error?: string }
					throw new Error(b.error ?? `HTTP ${r.status}`)
				}
				return r.json() as Promise<{ events: TaskEvent[] }>
			})
			.then((b) => setEvents(b.events))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
	}, [taskId])

	return (
		<Dialog open={taskId !== null} onClose={onClose} maxWidth="md" fullWidth>
			<DialogTitle>Task events</DialogTitle>
			<DialogContent>
				{error ? <Alert severity="error">{error}</Alert> : null}
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

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
	return `${Math.floor(ms / 3_600_000)}h ago`
}
