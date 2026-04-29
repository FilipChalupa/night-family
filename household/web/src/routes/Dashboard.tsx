import { Box, Stack } from '@mui/material'
import { Link } from '@tanstack/react-router'
import { useAppData } from '../AppContext.tsx'
import { ActivityPanel } from '../components/ActivityPanel.tsx'
import { MembersPanel } from '../components/MembersPanel.tsx'
import { NotificationsPanel } from '../components/NotificationsPanel.tsx'
import { ReposPanel } from '../components/ReposPanel.tsx'
import { TasksPanel } from '../components/TasksPanel.tsx'
import { TokensPanel } from '../components/TokensPanel.tsx'
import { UsersPanel } from '../components/UsersPanel.tsx'
import { EmptyState, Section } from './Root.tsx'

const DASHBOARD_TASKS_LIMIT = 5

export function Dashboard() {
	const { me, members, tasks, isAdmin, canSeeUsers, createTask, cancelTask, retryTask } =
		useAppData()

	const visibleTasks = tasks.slice(0, DASHBOARD_TASKS_LIMIT)
	const hiddenCount = Math.max(0, tasks.length - visibleTasks.length)

	return (
		<>
			<Section title="Activity">
				<ActivityPanel />
			</Section>

			<Section title={`Tasks (${tasks.length})`}>
				<Stack spacing={1.5}>
					<TasksPanel
						tasks={visibleTasks}
						canManage={isAdmin}
						onCreate={createTask}
						onCancel={cancelTask}
						onRetry={retryTask}
					/>
					<Box sx={{ textAlign: 'right' }}>
						<Link
							to="/tasks"
							style={{
								color: 'inherit',
								textDecoration: 'underline',
								fontSize: '0.875rem',
							}}
						>
							{hiddenCount > 0
								? `Show all tasks (${tasks.length}, +${hiddenCount} hidden) →`
								: 'Open tasks page →'}
						</Link>
					</Box>
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
					<EmptyState>
						No connected members yet. Spin up a Member container to see it here.
					</EmptyState>
				) : (
					<MembersPanel members={members} tasks={tasks} />
				)}
			</Section>

			{isAdmin ? (
				<>
					<Section title="Join Member Tokens">
						<TokensPanel canManage={isAdmin} />
					</Section>
					<Section title="Notification Channels">
						<NotificationsPanel canManage={isAdmin} />
					</Section>
				</>
			) : null}
		</>
	)
}
