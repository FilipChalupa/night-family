import {
	Alert,
	Box,
	Button,
	ButtonGroup,
	Chip,
	Link,
	Paper,
	Stack,
	Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useMutation } from '@tanstack/react-query'
import { useQuery } from '@tanstack/react-query'
import { Link as RouterLink } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAppData } from '../AppContext.tsx'
import { TasksPanel } from '../components/TasksPanel.tsx'
import { useTokensQuery, type TokenRecord } from '../components/TokensPanel.tsx'
import { memberDetailRoute } from '../router.tsx'
import { relativeTime } from '../time.ts'
import type { MemberSnapshot, MemberScheduleStatus, Schedule } from '../types.ts'
import { EmptyState, Section } from './Root.tsx'

export function MemberDetailPage() {
	const { memberId } = memberDetailRoute.useParams()
	const { members, tasks, householdProtocolVersion, isAdmin, cancelTask, retryTask, createTask } =
		useAppData()

	// Tokens endpoint is admin-only; non-admins skip the lookup and don't see token info.
	const tokensQuery = useTokensQuery({ enabled: isAdmin })
	const tokenById = new Map((tokensQuery.data?.tokens ?? []).map((t) => [t.id, t]))

	const fromStream = members.find((m) => m.memberId === memberId) ?? null
	// Fall back to the API for members older than the dashboard's offline window
	// (currently 7 days) — old PR-description links must keep resolving.
	const { data: fetched, error } = useQuery<MemberSnapshot | null>({
		queryKey: ['member', memberId],
		queryFn: async () => {
			const r = await fetch(`/api/members/${encodeURIComponent(memberId)}`)
			if (r.status === 404) return null
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			const body = (await r.json()) as { member: MemberSnapshot }
			return body.member
		},
		enabled: fromStream === null,
	})
	const member = fromStream ?? fetched ?? null

	const { data: tokenTotal } = useQuery<number>({
		queryKey: ['member-tokens', memberId],
		queryFn: async () => {
			const r = await fetch(`/api/stats/members/${encodeURIComponent(memberId)}/tokens`)
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			const body = (await r.json()) as { tokens: number }
			return body.tokens ?? 0
		},
		refetchInterval: 30_000,
	})

	const memberTasks = tasks.filter((t) => t.assignedMemberId === memberId)

	return (
		<>
			<Box sx={{ mb: 2 }}>
				<RouterLink
					to="/"
					style={{
						color: 'inherit',
						textDecoration: 'none',
						display: 'inline-flex',
						alignItems: 'center',
						gap: 6,
						fontSize: '0.875rem',
					}}
				>
					<ArrowBackIcon fontSize="small" />
					Back to dashboard
				</RouterLink>
			</Box>

			{!member ? (
				error ? (
					<Alert severity="error">
						Failed to load member: {(error as Error).message}
					</Alert>
				) : fromStream === null && fetched === null ? (
					<EmptyState>Member not found.</EmptyState>
				) : (
					<EmptyState>Loading member…</EmptyState>
				)
			) : (
				<>
					<Section title="Member">
						<MemberDetailCard
							member={member}
							householdProtocolVersion={householdProtocolVersion}
							token={isAdmin ? (tokenById.get(member.tokenId) ?? null) : undefined}
							totalTokensSpent={tokenTotal ?? null}
						/>
					</Section>

					{member.status !== 'offline' && member.schedule && member.scheduleStatus ? (
						<Section title="Schedule">
							<ScheduleStatusCard
								schedule={member.schedule}
								status={member.scheduleStatus}
								override={member.override}
							/>
						</Section>
					) : null}

					{isAdmin && member.status !== 'offline' ? (
						<Section title="Schedule override">
							<ScheduleOverridePanel
								memberId={member.memberId}
								skills={member.skills}
							/>
						</Section>
					) : null}

					<Section title={`Tasks by this member (${memberTasks.length})`}>
						{memberTasks.length === 0 ? (
							<EmptyState>This member hasn't been assigned any tasks yet.</EmptyState>
						) : (
							<TasksPanel
								tasks={memberTasks}
								canManage={isAdmin}
								onCreate={createTask}
								onCancel={cancelTask}
								onRetry={retryTask}
								showCreateForm={false}
							/>
						)}
					</Section>
				</>
			)}
		</>
	)
}

function MemberDetailCard({
	member,
	householdProtocolVersion,
	token,
	totalTokensSpent,
}: {
	member: MemberSnapshot
	householdProtocolVersion: string | null
	/** `undefined` = caller is not admin and shouldn't see token info; `null` = lookup miss. */
	token: TokenRecord | null | undefined
	/** All-time token total across every task assigned to this member; `null` while loading. */
	totalTokensSpent: number | null
}) {
	const protoSkew = compareProtocol(member.protocolVersion, householdProtocolVersion)
	return (
		<Paper variant="outlined" sx={{ p: 2 }}>
			<Stack spacing={2}>
				<Stack
					direction="row"
					spacing={1.5}
					sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
				>
					<Typography variant="h6" sx={{ fontWeight: 600 }}>
						<Typography component="span" color="text.secondary" variant="body2">
							Night{' '}
						</Typography>
						{member.displayName || member.memberName}
					</Typography>
					{member.displayName && member.displayName !== member.memberName ? (
						<Link
							href={`https://github.com/${encodeURIComponent(member.memberName)}`}
							target="_blank"
							rel="noopener noreferrer"
							underline="hover"
							color="text.secondary"
							sx={{ typography: 'body1' }}
						>
							@{member.memberName}
						</Link>
					) : null}
					<Chip
						label={member.status}
						size="small"
						color={statusColor(member.status)}
						variant="outlined"
					/>
				</Stack>

				<Field label="Member ID" value={member.memberId} mono />
				<Field label="Provider · Model" value={`${member.provider} · ${member.model}`} />
				<Field
					label="Total tokens spent"
					value={
						totalTokensSpent === null
							? '…'
							: `${formatTokens(totalTokensSpent)} (${totalTokensSpent.toLocaleString()})`
					}
				/>
				<Field label="Skills" value={member.skills.join(', ') || '—'} />
				<ReposField repos={member.repos} />
				<Field label="Worker profile" value={member.workerProfile} />
				<Field
					label="Protocol version"
					value={
						protoSkew === 'equal' || !householdProtocolVersion
							? member.protocolVersion
							: `${member.protocolVersion} (household: ${householdProtocolVersion})`
					}
				/>
				{token !== undefined ? (
					<TokenField token={token} fallbackId={member.tokenId} />
				) : null}
				<CurrentTaskField taskId={member.currentTask} />
				<Field
					label="Connected"
					value={`${relativeTime(member.connectedAt)} (${member.connectedAt})`}
				/>
				<Field
					label="Last heartbeat"
					value={`${relativeTime(member.lastHeartbeat)} (${member.lastHeartbeat})`}
				/>
				<Field
					label="First seen"
					value={`${relativeTime(member.firstConnectedAt)} (${member.firstConnectedAt})`}
				/>
			</Stack>
		</Paper>
	)
}

function TokenField({ token, fallbackId }: { token: TokenRecord | null; fallbackId: string }) {
	return (
		<Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.25, sm: 2 }}>
			<Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
				Joined via token
			</Typography>
			{token === null ? (
				<Typography variant="body2" color="text.secondary">
					(unknown — id {fallbackId})
				</Typography>
			) : (
				<Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
					<Typography variant="body2" sx={{ fontWeight: token.revoked_at ? 400 : 600 }}>
						{token.name}
					</Typography>
					{token.revoked_at ? (
						<Chip label="revoked" size="small" color="error" variant="outlined" />
					) : null}
					<Typography
						variant="caption"
						color="text.secondary"
						sx={{ fontFamily: 'monospace' }}
					>
						{token.id}
					</Typography>
				</Stack>
			)}
		</Stack>
	)
}

function CurrentTaskField({ taskId }: { taskId: string | null }) {
	return (
		<Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.25, sm: 2 }}>
			<Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
				Current task
			</Typography>
			{taskId === null ? (
				<Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
					—
				</Typography>
			) : (
				<RouterLink
					to="/tasks/$taskId"
					params={{ taskId }}
					style={{
						fontFamily: 'monospace',
						fontSize: '0.875rem',
						wordBreak: 'break-all',
					}}
				>
					{taskId}
				</RouterLink>
			)}
		</Stack>
	)
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.25, sm: 2 }}>
			<Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
				{label}
			</Typography>
			<Typography
				variant="body2"
				sx={{
					fontFamily: mono ? 'monospace' : undefined,
					wordBreak: 'break-all',
				}}
			>
				{value}
			</Typography>
		</Stack>
	)
}

function ReposField({ repos }: { repos: string[] | null }) {
	return (
		<Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.25, sm: 2 }}>
			<Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
				Repos allowlist
			</Typography>
			{repos === null ? (
				<Typography variant="body2">unconstrained</Typography>
			) : repos.length === 0 ? (
				<Typography variant="body2">— (none)</Typography>
			) : (
				<Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
					{repos.map((slug, i) => (
						<Stack
							key={slug}
							direction="row"
							spacing={0.5}
							sx={{ alignItems: 'baseline' }}
						>
							<Link
								href={`https://github.com/${slug.split('/').map(encodeURIComponent).join('/')}`}
								target="_blank"
								rel="noopener noreferrer"
								underline="hover"
								variant="body2"
								sx={{ wordBreak: 'break-all' }}
							>
								{slug}
							</Link>
							{i < repos.length - 1 ? (
								<Typography variant="body2" color="text.secondary">
									,
								</Typography>
							) : null}
						</Stack>
					))}
				</Stack>
			)}
		</Stack>
	)
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
	return value.toLocaleString()
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

function compareProtocol(member: string, household: string | null): 'equal' | 'skew' | 'unknown' {
	if (!household) return 'unknown'
	return member === household ? 'equal' : 'skew'
}

const PRESETS: Array<{ key: string; label: string; skills: string[] }> = [
	{
		key: 'implement',
		label: 'Implement-only',
		skills: ['implement'],
	},
	{
		key: 'night-mode',
		label: 'Night mode (everything)',
		skills: ['implement', 'review', 'triage', 'respond', 'summarize'],
	},
	{
		key: 'day-mode',
		label: 'Day mode (no implement)',
		skills: ['review', 'triage', 'respond', 'summarize'],
	},
]

const DURATIONS_MIN: Array<{ label: string; minutes: number }> = [
	{ label: '30 min', minutes: 30 },
	{ label: '1 h', minutes: 60 },
	{ label: '2 h', minutes: 120 },
	{ label: '8 h', minutes: 480 },
]

function ScheduleStatusCard({
	schedule,
	status,
	override,
}: {
	schedule: Schedule
	status: MemberScheduleStatus
	override: MemberSnapshot['override']
}) {
	// Re-render every 30s so the "in 4h 02m" countdown stays fresh between
	// server-pushed snapshot updates (which fire on heartbeat / status / edge
	// events but not purely on wall-clock advance).
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 30_000)
		return () => clearInterval(t)
	}, [])

	const next = Date.parse(status.nextTransitionAt)
	const overrideExpiresAt = override ? Date.parse(override.expiresAt) : null
	const overrideEffective = overrideExpiresAt !== null && overrideExpiresAt > now

	const phrase = (() => {
		if (overrideEffective) {
			return `Admin override active — clears in ${formatDelta(overrideExpiresAt - now)} (at ${formatLocal(new Date(overrideExpiresAt), schedule.timezone)})`
		}
		if (status.inNightWindow) {
			const name = status.activeWindow ?? 'night'
			return `Currently in "${name}" window — ends in ${formatDelta(next - now)} (at ${formatLocal(new Date(next), schedule.timezone)})`
		}
		return `Day mode — next window starts in ${formatDelta(next - now)} (at ${formatLocal(new Date(next), schedule.timezone)})`
	})()

	return (
		<Paper variant="outlined" sx={{ p: 2 }}>
			<Stack spacing={1.5}>
				<Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
					<Chip
						label={
							overrideEffective ? 'override' : status.inNightWindow ? 'night' : 'day'
						}
						size="small"
						color={
							overrideEffective
								? 'info'
								: status.inNightWindow
									? 'warning'
									: 'default'
						}
						variant="outlined"
					/>
					<Typography variant="body2">{phrase}</Typography>
				</Stack>
				<Field label="Timezone" value={schedule.timezone} />
				<Field
					label="Windows"
					value={
						schedule.nightWindows.length === 0
							? '— (no windows; implement is dropped at all times)'
							: schedule.nightWindows
									.map((w) => `${w.name} (${w.start}–${w.end})`)
									.join(', ')
					}
				/>
			</Stack>
		</Paper>
	)
}

/**
 * Render a positive ms duration as `1d 03h 14m`, `4h 02m`, or `42s`.
 * Negative inputs are clamped to "now".
 */
function formatDelta(ms: number): string {
	if (ms <= 0) return 'now'
	const totalSec = Math.floor(ms / 1000)
	const days = Math.floor(totalSec / 86_400)
	const hours = Math.floor((totalSec % 86_400) / 3600)
	const mins = Math.floor((totalSec % 3600) / 60)
	const secs = totalSec % 60
	if (days > 0)
		return `${days}d ${hours.toString().padStart(2, '0')}h ${mins.toString().padStart(2, '0')}m`
	if (hours > 0) return `${hours}h ${mins.toString().padStart(2, '0')}m`
	if (mins > 0) return `${mins}m ${secs.toString().padStart(2, '0')}s`
	return `${secs}s`
}

function formatLocal(d: Date, timezone: string): string {
	return new Intl.DateTimeFormat(undefined, {
		timeZone: timezone,
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).format(d)
}

function ScheduleOverridePanel({ memberId, skills }: { memberId: string; skills: string[] }) {
	const [preset, setPreset] = useState<(typeof PRESETS)[number]>(PRESETS[0]!)
	const [duration, setDuration] = useState<(typeof DURATIONS_MIN)[number]>(DURATIONS_MIN[2]!)
	const [feedback, setFeedback] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const send = useMutation({
		mutationFn: async (body: unknown) => {
			const r = await fetch(`/api/members/${encodeURIComponent(memberId)}/override`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
			const json = (await r.json().catch(() => ({}))) as Record<string, unknown>
			if (!r.ok) {
				throw new Error(typeof json.error === 'string' ? json.error : `HTTP ${r.status}`)
			}
			return json
		},
		onSuccess: (json) => {
			setError(null)
			if (json.cleared) {
				setFeedback('Override cleared.')
			} else if (typeof json.expires_at === 'string') {
				setFeedback(
					`Override active until ${new Date(json.expires_at).toLocaleTimeString()}.`,
				)
			} else {
				setFeedback('Override sent.')
			}
		},
		onError: (err) => {
			setFeedback(null)
			setError(err instanceof Error ? err.message : String(err))
		},
	})

	return (
		<Paper variant="outlined" sx={{ p: 2 }}>
			<Stack spacing={2}>
				<Typography variant="body2" color="text.secondary">
					Temporarily replace this member's schedule with a preset skill set. Useful when
					you're stepping away from the keyboard and want implementation work to start
					immediately. Override clears automatically when the duration ends — or you can
					clear it manually below. Currently advertising:{' '}
					<Box component="span" sx={{ fontFamily: 'monospace' }}>
						{skills.join(', ') || '—'}
					</Box>
				</Typography>

				<Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
					<Box>
						<Typography
							variant="caption"
							color="text.secondary"
							sx={{ display: 'block', mb: 0.5 }}
						>
							Mode
						</Typography>
						<ButtonGroup size="small" variant="outlined">
							{PRESETS.map((p) => (
								<Button
									key={p.key}
									variant={p.key === preset.key ? 'contained' : 'outlined'}
									onClick={() => setPreset(p)}
								>
									{p.label}
								</Button>
							))}
						</ButtonGroup>
					</Box>
					<Box>
						<Typography
							variant="caption"
							color="text.secondary"
							sx={{ display: 'block', mb: 0.5 }}
						>
							Duration
						</Typography>
						<ButtonGroup size="small" variant="outlined">
							{DURATIONS_MIN.map((d) => (
								<Button
									key={d.minutes}
									variant={
										d.minutes === duration.minutes ? 'contained' : 'outlined'
									}
									onClick={() => setDuration(d)}
								>
									{d.label}
								</Button>
							))}
						</ButtonGroup>
					</Box>
				</Stack>

				<Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
					<Button
						variant="contained"
						disabled={send.isPending}
						onClick={() =>
							send.mutate({
								skills: preset.skills,
								duration_minutes: duration.minutes,
							})
						}
					>
						{send.isPending ? 'Applying…' : `Apply for ${duration.label}`}
					</Button>
					<Button
						variant="outlined"
						color="warning"
						disabled={send.isPending}
						onClick={() => send.mutate({ skills: null })}
					>
						Clear override
					</Button>
				</Stack>

				{error ? (
					<Alert severity="error" variant="outlined">
						{error}
					</Alert>
				) : null}
				{feedback ? (
					<Alert severity="success" variant="outlined">
						{feedback}
					</Alert>
				) : null}
			</Stack>
		</Paper>
	)
}
