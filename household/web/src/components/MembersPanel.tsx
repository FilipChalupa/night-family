import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
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
import { useConfirm } from './ConfirmDialog.tsx'
import { relativeTime } from '../time.ts'
import type {
	McpServerInfo,
	MemberScheduleStatus,
	MemberSnapshot,
	Skill,
	TaskRecord,
} from '../types.ts'
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
	const confirm = useConfirm()
	const handleCancel = async (taskId: string) => {
		const ok = await confirm({
			title: 'Cancel this task?',
			description:
				'The member is working on it right now — cancelling discards the in-progress work and the tokens already spent.',
			confirmLabel: 'Cancel task',
			cancelLabel: 'Keep',
			confirmColor: 'error',
		})
		if (!ok) return
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
						<TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
							MCP
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
						<TableRow key={m.memberId} hover>
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
								<Stack
									spacing={0.5}
									sx={{ flexDirection: 'row', alignItems: 'center' }}
								>
									<Chip
										label={m.status}
										size="small"
										color={statusColor(m.status)}
										variant="outlined"
									/>
									{m.onlineSessionCount && m.onlineSessionCount > 1 ? (
										<Tooltip
											title={`This member has ${m.onlineSessionCount} online sessions at once — it's probably running on more than one machine (or a stale session didn't disconnect cleanly). Only the most recent session is shown.`}
										>
											<WarningAmberRoundedIcon
												color="warning"
												fontSize="small"
												aria-label={`${m.onlineSessionCount} concurrent online sessions`}
											/>
										</Tooltip>
									) : null}
								</Stack>
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
								<SkillsCell
									fullSkills={m.fullSkills}
									activeSkills={m.skills}
									scheduleStatus={m.scheduleStatus}
								/>
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
								<Typography variant="body2" color="text.secondary">
									{m.workerProfile}
								</Typography>
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', lg: 'table-cell' } }}>
								<McpCell servers={m.mcpServers} />
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

function SkillsCell({
	fullSkills,
	activeSkills,
	scheduleStatus,
}: {
	fullSkills: Skill[]
	activeSkills: Skill[]
	scheduleStatus: MemberScheduleStatus | null
}) {
	const active = new Set(activeSkills)
	// Show the Member's full static capability set; dim the ones the
	// schedule (or a missing override) has gated off right now.
	const inactiveTooltip = (skill: Skill): string => {
		const base = `${skill} isn't offered right now — it's gated by this member's schedule.`
		if (!scheduleStatus) return base
		const when = relativeTime(scheduleStatus.nextTransitionAt)
		return scheduleStatus.inNightWindow
			? `${base} The active window (${scheduleStatus.activeWindow ?? 'night'}) ends ${when}.`
			: `${base} Next active window starts ${when}.`
	}
	return (
		<Box
			sx={{
				display: 'flex',
				flexWrap: 'wrap',
				gap: 0.25,
				columnGap: 0.5,
				alignItems: 'center',
			}}
		>
			{fullSkills.map((skill, i) => {
				const isActive = active.has(skill)
				const text = (
					<Typography
						component="span"
						variant="body2"
						color={isActive ? 'text.secondary' : 'text.disabled'}
						sx={isActive ? undefined : { textDecoration: 'line-through' }}
					>
						{skill}
						{i < fullSkills.length - 1 ? ',' : ''}
					</Typography>
				)
				return isActive ? (
					<Box component="span" key={skill}>
						{text}
					</Box>
				) : (
					<Tooltip key={skill} title={inactiveTooltip(skill)}>
						<Box component="span">{text}</Box>
					</Tooltip>
				)
			})}
		</Box>
	)
}

function McpCell({ servers }: { servers: McpServerInfo[] }) {
	if (servers.length === 0) {
		return (
			<Typography variant="body2" color="text.disabled">
				—
			</Typography>
		)
	}
	return (
		<Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
			{servers.map((s) =>
				s.status === 'live' ? (
					<Tooltip key={s.name} title={`${s.tool_count} tool(s) available`}>
						<Chip label={`${s.name} ${s.tool_count}`} size="small" variant="outlined" />
					</Tooltip>
				) : (
					<Tooltip key={s.name} title="Configured but not currently reachable">
						<Chip
							label={`${s.name} down`}
							size="small"
							color="warning"
							variant="outlined"
						/>
					</Tooltip>
				),
			)}
		</Box>
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
