import { useState } from 'react'
import type { TaskKind, TaskRecord } from '../types.ts'

interface Props {
	tasks: TaskRecord[]
	onCreate: (input: {
		kind: TaskKind
		title: string
		description: string
		repo: string | null
	}) => Promise<void>
	onCancel: (id: string) => Promise<void>
}

const KINDS: TaskKind[] = ['implement', 'review', 'respond', 'summarize', 'estimate']
const ACTIVE: ReadonlyArray<TaskRecord['status']> = [
	'new',
	'estimating',
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
]

export function TasksPanel({ tasks, onCreate, onCancel }: Props) {
	return (
		<>
			<NewTaskForm onCreate={onCreate} />
			<TasksTable tasks={tasks} onCancel={onCancel} />
		</>
	)
}

function NewTaskForm({ onCreate }: { onCreate: Props['onCreate'] }) {
	const [kind, setKind] = useState<TaskKind>('implement')
	const [title, setTitle] = useState('')
	const [description, setDescription] = useState('')
	const [repo, setRepo] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async (e: React.FormEvent) => {
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
		<form className="task-form" onSubmit={submit}>
			<div className="row">
				<select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
					{KINDS.map((k) => (
						<option key={k} value={k}>
							{k}
						</option>
					))}
				</select>
				<input
					type="text"
					placeholder="title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					required
					maxLength={200}
				/>
				<input
					type="text"
					placeholder="repo (org/name, optional)"
					value={repo}
					onChange={(e) => setRepo(e.target.value)}
				/>
			</div>
			<textarea
				placeholder="description — what should the agent do?"
				value={description}
				onChange={(e) => setDescription(e.target.value)}
				rows={3}
			/>
			<div className="row end">
				{error ? <span className="error">{error}</span> : null}
				<button type="submit" disabled={submitting || !title.trim()}>
					{submitting ? 'Creating…' : 'Create task'}
				</button>
			</div>
		</form>
	)
}

function TasksTable({ tasks, onCancel }: { tasks: TaskRecord[]; onCancel: Props['onCancel'] }) {
	if (tasks.length === 0) {
		return <div className="empty">No tasks yet. Create one above.</div>
	}
	return (
		<table>
			<thead>
				<tr>
					<th>Title</th>
					<th>Kind</th>
					<th>Status</th>
					<th>Assigned</th>
					<th>Repo</th>
					<th>Estimate</th>
					<th>Created</th>
					<th />
				</tr>
			</thead>
			<tbody>
				{tasks.map((t) => (
					<tr key={t.id}>
						<td>
							<strong>{t.title}</strong>
							{t.failureReason ? (
								<div className="dim" style={{ fontSize: 11 }}>
									✗ {t.failureReason}
								</div>
							) : null}
						</td>
						<td className="dim">{t.kind}</td>
						<td>
							<span className={`badge status-${t.status}`}>{t.status}</span>
						</td>
						<td className="dim">{t.assignedMemberName ?? '—'}</td>
						<td className="dim">{t.repo ?? '—'}</td>
						<td className="dim">
							{t.estimateSize ? (
								<>
									{t.estimateSize}
									{t.estimateBlockers && t.estimateBlockers.length > 0 ? (
										<div style={{ fontSize: 11 }}>
											blockers: {t.estimateBlockers.length}
										</div>
									) : null}
								</>
							) : (
								'—'
							)}
						</td>
						<td className="dim" title={t.createdAt}>
							{relativeTime(t.createdAt)}
						</td>
						<td>
							{ACTIVE.includes(t.status) ? (
								<button
									type="button"
									className="ghost"
									onClick={() => {
										void onCancel(t.id)
									}}
								>
									Cancel
								</button>
							) : null}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
	return `${Math.floor(ms / 3_600_000)}h ago`
}
