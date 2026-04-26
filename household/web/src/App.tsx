import { useEffect, useState } from 'react'
import { MembersPanel } from './components/MembersPanel.tsx'
import type { MemberSnapshot } from './types.ts'
import { useMembersStream } from './hooks/useMembersStream.ts'

interface Health {
	status: string
	household: string
	uptimeSec: number
	members: number
}

export function App() {
	const [health, setHealth] = useState<Health | null>(null)
	const { members, connected } = useMembersStream()

	useEffect(() => {
		void fetch('/health')
			.then((r) => r.json())
			.then((j: Health) => setHealth(j))
			.catch(() => setHealth(null))
	}, [])

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
				<h2>Members ({members.length})</h2>
				<MembersList members={members} />
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
