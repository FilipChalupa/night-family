import { Alert, Box, Chip, Paper, Stack, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useAppData } from '../AppContext.tsx'
import { TasksPanel } from '../components/TasksPanel.tsx'
import { memberDetailRoute } from '../router.tsx'
import { relativeTime } from '../time.ts'
import type { MemberSnapshot } from '../types.ts'
import { EmptyState, Section } from './Root.tsx'

export function MemberDetailPage() {
	const { memberId } = memberDetailRoute.useParams()
	const { members, tasks, householdProtocolVersion, isAdmin, cancelTask, retryTask, createTask } =
		useAppData()

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

	const memberTasks = tasks.filter((t) => t.assignedMemberId === memberId)

	return (
		<>
			<Box sx={{ mb: 2 }}>
				<Link
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
				</Link>
			</Box>

			{!member ? (
				error ? (
					<Alert severity="error">Failed to load member: {(error as Error).message}</Alert>
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
						/>
					</Section>

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
}: {
	member: MemberSnapshot
	householdProtocolVersion: string | null
}) {
	const protoSkew = compareProtocol(member.protocolVersion, householdProtocolVersion)
	return (
		<Paper variant="outlined" sx={{ p: 2 }}>
			<Stack spacing={2}>
				<Stack direction="row" spacing={1.5} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
					<Typography variant="h6" sx={{ fontWeight: 600 }}>
						<Typography component="span" color="text.secondary" variant="body2">
							Night{' '}
						</Typography>
						{member.displayName || member.memberName}
					</Typography>
					{member.displayName && member.displayName !== member.memberName ? (
						<Typography component="span" color="text.secondary">
							@{member.memberName}
						</Typography>
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
				<Field label="Skills" value={member.skills.join(', ') || '—'} />
				<Field label="Repos allowlist" value={reposLabel(member.repos)} />
				<Field label="Worker profile" value={member.workerProfile} />
				<Field
					label="Protocol version"
					value={
						protoSkew === 'equal' || !householdProtocolVersion
							? member.protocolVersion
							: `${member.protocolVersion} (household: ${householdProtocolVersion})`
					}
				/>
				<Field label="Current task" value={member.currentTask ?? '—'} mono />
				<Field label="Connected" value={`${relativeTime(member.connectedAt)} (${member.connectedAt})`} />
				<Field label="Last heartbeat" value={`${relativeTime(member.lastHeartbeat)} (${member.lastHeartbeat})`} />
				<Field label="First seen" value={`${relativeTime(member.firstConnectedAt)} (${member.firstConnectedAt})`} />
			</Stack>
		</Paper>
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

function reposLabel(repos: string[] | null): string {
	if (repos === null) return 'unconstrained'
	if (repos.length === 0) return '— (none)'
	return repos.join(', ')
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

function compareProtocol(member: string, household: string | null): 'equal' | 'skew' | 'unknown' {
	if (!household) return 'unknown'
	return member === household ? 'equal' : 'skew'
}

