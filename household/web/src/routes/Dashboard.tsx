import { Alert, Box, Skeleton, Stack } from '@mui/material'
import { Link } from '@tanstack/react-router'
import { Suspense, lazy } from 'react'
import { useAppData } from '../AppContext.tsx'
import { MembersPanel } from '../components/MembersPanel.tsx'
import { NotificationsPanel } from '../components/NotificationsPanel.tsx'
import { ReposPanel } from '../components/ReposPanel.tsx'
import { TasksPanel, isQueueBlockedByRepo } from '../components/TasksPanel.tsx'
import { TokensPanel, useTokensQuery } from '../components/TokensPanel.tsx'
import { UsersPanel } from '../components/UsersPanel.tsx'
import { OPEN_STATUSES, isWaitingOnHuman, type MemberSnapshot, type TaskRecord } from '../types.ts'
import { EmptyState, Section } from './Root.tsx'

// Charts (`@mui/x-charts`) are heavy and live only in ActivityPanel, so split
// them into their own chunk and stream the panel in after first paint.
const ActivityPanel = lazy(() =>
	import('../components/ActivityPanel.tsx').then((m) => ({ default: m.ActivityPanel })),
)

const DASHBOARD_TASKS_LIMIT = 5

export function Dashboard() {
	const {
		me,
		members,
		tasks,
		householdProtocolVersion,
		isAdmin,
		canSeeUsers,
		createTask,
		cancelTask,
		retryTask,
		lastMessageAt,
	} = useAppData()

	const visibleTasks = tasks.slice(0, DASHBOARD_TASKS_LIMIT)
	const hiddenCount = Math.max(0, tasks.length - visibleTasks.length)
	const openCount = tasks.filter((t) => OPEN_STATUSES.includes(t.status)).length
	const waitingCount = tasks.filter(isWaitingOnHuman).length

	// Admin-only — endpoint 403s for non-admins, so don't fetch.
	const tokensQuery = useTokensQuery({ enabled: isAdmin })

	return (
		<>
			<NeedsAttention tasks={tasks} members={members} />
			<Section title="Activity">
				<Suspense fallback={<Skeleton variant="rounded" height={240} />}>
					<ActivityPanel />
				</Suspense>
			</Section>

			<Section
				title={`Tasks (${tasks.length}) · ${openCount} open · ${waitingCount} waiting`}
			>
				<Stack spacing={1.5}>
					<TasksPanel
						tasks={visibleTasks}
						canManage={isAdmin}
						onCreate={createTask}
						onCancel={cancelTask}
						onRetry={retryTask}
						showCreateForm={false}
					/>
					<Stack spacing={0.5} sx={{ alignItems: 'flex-end' }}>
						{waitingCount > 0 ? (
							<Link
								to="/tasks"
								search={{
									page: 0,
									pageSize: 25,
									q: '',
									status: null,
									waiting: 'human',
								}}
								style={{
									color: 'inherit',
									textDecoration: 'underline',
									fontSize: '0.875rem',
								}}
							>
								{`${waitingCount} waiting on human →`}
							</Link>
						) : null}
						<Link
							to="/tasks"
							search={{ page: 0, pageSize: 25, q: '', status: null, waiting: null }}
							style={{
								color: 'inherit',
								textDecoration: 'underline',
								fontSize: '0.875rem',
							}}
						>
							{hiddenCount > 0
								? `Open tasks page (${tasks.length} tasks, +${hiddenCount} hidden, create new) →`
								: 'Open tasks page (create new, see all) →'}
						</Link>
					</Stack>
				</Stack>
			</Section>

			<Section title="Repos">
				<ReposPanel canManage={isAdmin} />
			</Section>

			{canSeeUsers ? (
				<Section title="Users">
					<UsersPanel canManage={isAdmin} currentUsername={me.username ?? null} />
				</Section>
			) : null}

			<Section title={`Members (${members.length})`}>
				{members.length === 0 ? (
					lastMessageAt === null ? (
						<Skeleton variant="rounded" height={72} />
					) : (
						<EmptyState>
							No connected members yet. Spin up a Member container to see it here.
						</EmptyState>
					)
				) : (
					<MembersPanel
						members={members}
						tasks={tasks}
						householdProtocolVersion={householdProtocolVersion}
						canManage={isAdmin}
						onCancel={cancelTask}
						tokens={isAdmin ? tokensQuery.data?.tokens : undefined}
					/>
				)}
			</Section>

			{isAdmin ? (
				<>
					<Section title="Join Member Tokens">
						<TokensPanel canManage={isAdmin} members={members} />
					</Section>
					<Section title="Notification Channels">
						<NotificationsPanel canManage={isAdmin} />
					</Section>
				</>
			) : null}
		</>
	)
}

const TASKS_SEARCH = { page: 0, pageSize: 25, q: '', status: null, waiting: null } as const
const ATTENTION_LINK_SX = {
	color: 'inherit',
	textDecoration: 'underline',
	fontSize: '0.875rem',
} as const

/**
 * A single roll-up of things that need the operator's attention, so the signals
 * (otherwise scattered across panels) are visible at a glance on first paint.
 * Renders nothing when all is well. Uses only the live WS snapshot — no fetches.
 */
function NeedsAttention({ tasks, members }: { tasks: TaskRecord[]; members: MemberSnapshot[] }) {
	const failed = tasks.filter((t) => t.status === 'failed').length
	const blocked = tasks.filter((t) => isQueueBlockedByRepo(t, members)).length
	const reposErrors = members.filter((m) => m.status !== 'offline' && m.lastReposError).length

	if (failed === 0 && blocked === 0 && reposErrors === 0) return null

	return (
		<Alert severity="warning" variant="outlined" sx={{ mb: 3 }}>
			<Stack spacing={0.25}>
				{failed > 0 ? (
					<Link
						to="/tasks"
						search={{ ...TASKS_SEARCH, status: ['failed'] }}
						style={ATTENTION_LINK_SX}
					>
						{failed} failed task{failed === 1 ? '' : 's'} →
					</Link>
				) : null}
				{blocked > 0 ? (
					<Link to="/tasks" search={TASKS_SEARCH} style={ATTENTION_LINK_SX}>
						{blocked} queued task{blocked === 1 ? '' : 's'} with no member covering the
						repo →
					</Link>
				) : null}
				{reposErrors > 0 ? (
					<Link to="/" style={ATTENTION_LINK_SX}>
						{reposErrors} member{reposErrors === 1 ? '' : 's'} failed to refresh
						accessible repos →
					</Link>
				) : null}
			</Stack>
		</Alert>
	)
}
