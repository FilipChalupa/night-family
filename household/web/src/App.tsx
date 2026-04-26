import { useEffect, useState } from 'react'
import { MembersPanel } from './components/MembersPanel.tsx'
import { ReposPanel } from './components/ReposPanel.tsx'
import { TasksPanel } from './components/TasksPanel.tsx'
import { useUiStream } from './hooks/useUiStream.ts'
import type { MemberSnapshot, TaskKind } from './types.ts'

interface Health {
	status: string
	household: string
	uptimeSec: number
	members: number
}

export function App() {
	const [health, setHealth] = useState<Health | null>(null)
	const { members, tasks, connected } = useUiStream()

	useEffect(() => {
		void fetch('/health')
			.then((r) => r.json())
			.then((j: Health) => setHealth(j))
			.catch(() => setHealth(null))
	}, [])

	const createTask = async (input: {
		kind: TaskKind
		title: string
		description: string
		repo: string | null
	}) => {
		const res = await fetch('/api/tasks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
		})
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			throw new Error(body.error ?? `HTTP ${res.status}`)
		}
	}

	const cancelTask = async (id: string) => {
		await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' })
	}

	return (
		<div className="app">
			<header className="top">
				<h1>
					<span className={`dot ${connected ? 'live' : 'dead'}`} />
					{health?.household ?? 'Night Agents'}
				</h1>
				<div className="meta">
					{health ? (
						<>
							uptime {formatUptime(health.uptimeSec)} · status {health.status}
						</>
					) : (
						'connecting…'
					)}
				</div>
			</header>

			<section className="section">
				<h2>Tasks ({tasks.length})</h2>
				<TasksPanel tasks={tasks} onCreate={createTask} onCancel={cancelTask} />
			</section>

			<section className="section">
				<h2>Members ({members.length})</h2>
				<MembersList members={members} />
			</section>

			<section className="section">
				<h2>Repos</h2>
				<ReposPanel />
			</section>
		</div>
	)
}

function MembersList({ members }: { members: MemberSnapshot[] }) {
	if (members.length === 0) {
		return (
			<div className="empty">
				No connected members yet. Spin up a Member container to see it here.
			</div>
		)
	}
	return <MembersPanel members={members} />
}

function formatUptime(sec: number): string {
	if (sec < 60) return `${sec}s`
	const m = Math.floor(sec / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	const rem = m % 60
	return `${h}h ${rem}m`
}
