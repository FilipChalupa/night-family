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
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { relativeTime } from '../time.ts'
import type { MemberSnapshot, TaskRecord } from '../types.ts'
import { RefreshReposButton } from './RefreshReposButton.tsx'
import type { TokenRecord } from './TokensPanel.tsx'

interface Props {
	members: MemberSnapshot[]
	tasks: TaskRecord[]
	householdProtocolVersion: string | null
	canManage: boolean
	onCancel: (taskId: string) => Promise<void>
	/** Admin-only — when present, members get a "Token" column linking to the token's Members. */
	tokens?: TokenRecord[]
}

export function MembersPanel({
	members,
	tasks,
	householdProtocolVersion,
	canManage,
	onCancel,
	tokens,
}: Props) {
	const tokenById = new Map((tokens ?? []).map((t) => [t.id, t]))
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
						<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
							Provider · Model
						</TableCell>
						<TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
							Skills
						</TableCell>
						<TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
							Profile
						</TableCell>
						<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
							Protocol
						</TableCell>
						{tokens ? (
							<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
								Token
							</TableCell>
						) : null}
						<TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
							Connected
						</TableCell>
						<TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
							First seen
						</TableCell>
						{canManage ? <TableCell align="right">Actions</TableCell> : null}
					</TableRow>
				</TableHead>
				<TableBody>
					{members.map((m) => (
						<TableRow key={m.sessionId} hover>
							<TableCell>
								<Link
									to="/members/$memberId"
									params={{ memberId: m.memberId }}
									style={{ color: 'inherit', textDecoration: 'none' }}
								>
									<Box>
										<Typography
											component="span"
											color="text.secondary"
											variant="body2"
										>
											Night{' '}
										</Typography>
										<Typography component="span" sx={{ fontWeight: 600 }}>
											{m.displayName || m.memberName}
										</Typography>
										{m.displayName && m.displayName !== m.memberName ? (
											<Typography
												component="span"
												color="text.secondary"
												variant="body2"
											>
												{' '}
												@{m.memberName}
											</Typography>
										) : null}
									</Box>
									<Typography variant="caption" color="text.secondary">
										{m.memberId.slice(0, 8)}…
									</Typography>
								</Link>
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
							<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
								<Typography variant="body2">{m.provider}</Typography>
								<Typography variant="caption" color="text.secondary">
									{m.model}
								</Typography>
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
								<Typography variant="body2" color="text.secondary">
									{m.skills.join(', ')}
								</Typography>
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
								<Typography variant="body2" color="text.secondary">
									{m.workerProfile}
								</Typography>
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
								<ProtocolCell
									memberVersion={m.protocolVersion}
									householdVersion={householdProtocolVersion}
								/>
							</TableCell>
							{tokens ? (
								<TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
									<TokenCell
										token={tokenById.get(m.tokenId) ?? null}
										fallbackId={m.tokenId}
									/>
								</TableCell>
							) : null}
							<TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
								<Tooltip title={m.connectedAt}>
									<Typography variant="body2" color="text.secondary">
										{relativeTime(m.connectedAt)}
									</Typography>
								</Tooltip>
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
								<Tooltip title={m.firstConnectedAt}>
									<Typography variant="body2" color="text.secondary">
										{relativeTime(m.firstConnectedAt)}
									</Typography>
								</Tooltip>
							</TableCell>
							{canManage ? (
								<TableCell align="right">
									<RefreshReposButton
										memberId={m.memberId}
										disabled={m.status === 'offline'}
										lastError={m.lastReposError}
									/>
								</TableCell>
							) : null}
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
	if (skew === 'unknown') {
		return (
			<Typography variant="body2" color="text.secondary">
				{memberVersion}
			</Typography>
		)
	}
	const color: 'success' | 'warning' | 'error' =
		skew === 'major-mismatch' ? 'error' : skew === 'equal' ? 'success' : 'warning'
	const tooltip =
		skew === 'major-mismatch'
			? `Major mismatch — household runs ${householdVersion}. This connection should have been rejected.`
			: skew === 'minor-skew'
				? `Minor skew — household runs ${householdVersion}. Connection accepted; expect a warning in logs on both sides.`
				: skew === 'patch-skew'
					? `Patch difference — household runs ${householdVersion}. Harmless.`
					: `Matches household ${householdVersion}.`
	return (
		<Tooltip title={tooltip}>
			<Chip label={memberVersion} size="small" color={color} variant="outlined" />
		</Tooltip>
	)
}

function TokenCell({ token, fallbackId }: { token: TokenRecord | null; fallbackId: string }) {
	if (!token) {
		return (
			<Tooltip
				title={`Unknown token (id: ${fallbackId}). It may have been revoked or deleted.`}
			>
				<Typography variant="body2" color="text.secondary">
					(unknown)
				</Typography>
			</Tooltip>
		)
	}
	if (token.revoked_at) {
		return (
			<Tooltip title={`Revoked at ${token.revoked_at}`}>
				<Chip label={token.name} size="small" color="error" variant="outlined" />
			</Tooltip>
		)
	}
	return (
		<Tooltip title={`Token id: ${token.id}`}>
			<Typography variant="body2">{token.name}</Typography>
		</Tooltip>
	)
}
