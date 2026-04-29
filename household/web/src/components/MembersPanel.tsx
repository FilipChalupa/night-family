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
import type { MemberSnapshot, TaskRecord } from '../types.ts'

interface Props {
	members: MemberSnapshot[]
	tasks: TaskRecord[]
}

export function MembersPanel({ members, tasks }: Props) {
	const tasksById = new Map(tasks.map((t) => [t.id, t]))
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
									<Typography
										component="span"
										color="text.secondary"
										variant="body2"
									>
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
									color={statusColor(m.status)}
									variant="outlined"
								/>
								{m.currentTask ? (
									<Box sx={{ mt: 0.5 }}>
										{(() => {
											const task = tasksById.get(m.currentTask)
											if (!task) {
												return (
													<Typography variant="caption" color="text.secondary">
														task {m.currentTask}
													</Typography>
												)
											}
											return (
												<Tooltip
													title={task.description || task.title}
													placement="top"
												>
													<Box>
														<Typography
															variant="caption"
															color="text.secondary"
															sx={{ display: 'block' }}
														>
															{task.kind}
															{task.repo ? ` · ${task.repo}` : ''}
														</Typography>
														<Typography
															variant="body2"
															sx={{
																display: '-webkit-box',
																WebkitLineClamp: 2,
																WebkitBoxOrient: 'vertical',
																overflow: 'hidden',
																lineHeight: 1.3,
																maxWidth: 320,
															}}
														>
															{task.title}
														</Typography>
													</Box>
												</Tooltip>
											)
										})()}
									</Box>
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

function statusColor(
	status: MemberSnapshot['status'],
): 'success' | 'warning' | 'default' {
	switch (status) {
		case 'idle':
			return 'success'
		case 'busy':
			return 'warning'
		case 'offline':
			return 'default'
	}
}

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
	return `${Math.floor(ms / 3_600_000)}h ago`
}
