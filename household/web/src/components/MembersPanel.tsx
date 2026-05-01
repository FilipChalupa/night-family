import {
	Box,
	Button,
	Chip,
	Paper,
	Stack,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	Tooltip,
	Typography,
} from '@mui/material'
import { useState } from 'react'
import type { MemberSnapshot, TaskRecord } from '../types.ts'

interface Props {
	members: MemberSnapshot[]
	tasks: TaskRecord[]
	householdProtocolVersion: string | null
	canManage: boolean
	onCancel: (taskId: string) => Promise<void>
}

export function MembersPanel({
	members,
	tasks,
	householdProtocolVersion,
	canManage,
	onCancel,
}: Props) {
	const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null)
	const [cancelError, setCancelError] = useState<{ taskId: string; message: string } | null>(null)
	const handleCancel = async (taskId: string) => {
		setCancellingTaskId(taskId)
		setCancelError(null)
		try {
			await onCancel(taskId)
		} catch (err) {
			setCancelError({
				taskId,
				message: err instanceof Error ? err.message : String(err),
			})
		} finally {
			setCancellingTaskId(null)
		}
	}
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
						<TableCell>Protocol</TableCell>
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
									<Stack spacing={0.5} sx={{ mt: 0.5, alignItems: 'flex-start' }}>
										{(() => {
											const task = tasksById.get(m.currentTask)
											if (!task) {
												return (
													<Typography
														variant="caption"
														color="text.secondary"
													>
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
										{canManage ? (
											<>
												<Button
													size="small"
													variant="outlined"
													color="error"
													disabled={cancellingTaskId === m.currentTask}
													onClick={() => {
														void handleCancel(m.currentTask!)
													}}
												>
													{cancellingTaskId === m.currentTask
														? 'Cancelling…'
														: 'Cancel'}
												</Button>
												{cancelError?.taskId === m.currentTask ? (
													<Typography
														variant="caption"
														color="error"
														sx={{ display: 'block' }}
													>
														{cancelError.message}
													</Typography>
												) : null}
											</>
										) : null}
									</Stack>
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
								<ProtocolCell
									memberVersion={m.protocolVersion}
									householdVersion={householdProtocolVersion}
								/>
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

function statusColor(status: MemberSnapshot['status']): 'success' | 'warning' | 'default' {
	switch (status) {
		case 'idle':
			return 'success'
		case 'busy':
			return 'warning'
		case 'offline':
			return 'default'
	}
}

type ProtocolSkew = 'unknown' | 'equal' | 'patch-skew' | 'minor-skew' | 'major-mismatch'

function protocolSkew(member: string, household: string | null): ProtocolSkew {
	if (!household) return 'unknown'
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(member)
	const h = /^(\d+)\.(\d+)\.(\d+)$/.exec(household)
	if (!m || !h) return 'major-mismatch'
	if (m[1] !== h[1]) return 'major-mismatch'
	if (m[2] !== h[2]) return 'minor-skew'
	if (m[3] !== h[3]) return 'patch-skew'
	return 'equal'
}

function ProtocolCell({
	memberVersion,
	householdVersion,
}: {
	memberVersion: string
	householdVersion: string | null
}) {
	const skew = protocolSkew(memberVersion, householdVersion)
	if (skew === 'equal' || skew === 'unknown') {
		return (
			<Typography variant="body2" color="text.secondary">
				{memberVersion}
			</Typography>
		)
	}
	const color =
		skew === 'major-mismatch' ? 'error' : skew === 'minor-skew' ? 'warning' : 'default'
	const tooltip =
		skew === 'major-mismatch'
			? `Major mismatch — household runs ${householdVersion}. This connection should have been rejected.`
			: skew === 'minor-skew'
				? `Minor skew — household runs ${householdVersion}. Connection accepted; expect a warning in logs on both sides.`
				: `Patch difference — household runs ${householdVersion}. Harmless.`
	return (
		<Tooltip title={tooltip}>
			<Chip label={memberVersion} size="small" color={color} variant="outlined" />
		</Tooltip>
	)
}

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
	return `${Math.floor(ms / 3_600_000)}h ago`
}
