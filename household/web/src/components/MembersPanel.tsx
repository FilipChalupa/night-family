import {
	Box,
	Chip,
	Paper,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	Tooltip,
	Typography,
} from '@mui/material'
import type { MemberSnapshot } from '../types.ts'

interface Props {
	members: MemberSnapshot[]
}

export function MembersPanel({ members }: Props) {
	return (
		<TableContainer component={Paper} variant="outlined">
			<Table size="small">
				<TableHead>
					<TableRow>
						<TableCell>Name</TableCell>
						<TableCell>Status</TableCell>
						<TableCell>Provider · Model</TableCell>
						<TableCell>Skills</TableCell>
						<TableCell>Profile</TableCell>
						<TableCell>Connected</TableCell>
					</TableRow>
				</TableHead>
				<TableBody>
					{members.map((m) => (
						<TableRow key={m.sessionId} hover>
							<TableCell>
								<Box>
									<Typography component="span" color="text.secondary" variant="body2">
										Night{' '}
									</Typography>
									<Typography component="span" sx={{ fontWeight: 600 }}>
										{m.memberName}
									</Typography>
								</Box>
								<Typography variant="caption" color="text.secondary">
									{m.memberId.slice(0, 8)}…
								</Typography>
							</TableCell>
							<TableCell>
								<Chip
									label={m.status}
									size="small"
									color={m.status === 'idle' ? 'success' : 'warning'}
									variant="outlined"
								/>
								{m.currentTask ? (
									<Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
										task {m.currentTask}
									</Typography>
								) : null}
							</TableCell>
							<TableCell>
								<Typography variant="body2">{m.provider}</Typography>
								<Typography variant="caption" color="text.secondary">
									{m.model}
								</Typography>
							</TableCell>
							<TableCell>
								<Typography variant="body2" color="text.secondary">
									{m.skills.join(', ')}
								</Typography>
							</TableCell>
							<TableCell>
								<Typography variant="body2" color="text.secondary">
									{m.workerProfile}
								</Typography>
							</TableCell>
							<TableCell>
								<Tooltip title={m.connectedAt}>
									<Typography variant="body2" color="text.secondary">
										{relativeTime(m.connectedAt)}
									</Typography>
								</Tooltip>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableContainer>
	)
}

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
	return `${Math.floor(ms / 3_600_000)}h ago`
}
