import type { MemberSnapshot } from '../types.ts'

interface Props {
	members: MemberSnapshot[]
}

export function MembersPanel({ members }: Props) {
	return (
		<table>
			<thead>
				<tr>
					<th>Name</th>
					<th>Status</th>
					<th>Provider · Model</th>
					<th>Skills</th>
					<th>Profile</th>
					<th>Connected</th>
				</tr>
			</thead>
			<tbody>
				{members.map((m) => (
					<tr key={m.sessionId}>
						<td>
							<span className="dim">Night </span>
							<strong>{m.memberName}</strong>
							<div className="dim" style={{ fontSize: 11 }}>
								{m.memberId.slice(0, 8)}…
							</div>
						</td>
						<td>
							<span className={`badge ${m.status}`}>{m.status}</span>
							{m.currentTask ? (
								<div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
									task {m.currentTask}
								</div>
							) : null}
						</td>
						<td>
							{m.provider}
							<div className="dim" style={{ fontSize: 11 }}>
								{m.model}
							</div>
						</td>
						<td className="dim">{m.skills.join(', ')}</td>
						<td className="dim">{m.workerProfile}</td>
						<td className="dim" title={m.connectedAt}>
							{relativeTime(m.connectedAt)}
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
