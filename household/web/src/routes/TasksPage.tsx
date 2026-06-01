import { Box, Stack, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useAppData } from '../AppContext.tsx'
import { OPEN_STATUSES, TasksFilterBar, filterTasks } from '../components/TasksFilterBar.tsx'
import { TasksPanel } from '../components/TasksPanel.tsx'
import { tasksRoute } from '../router.tsx'
import { Section } from './Root.tsx'

export function TasksPage() {
	const { tasks, isAdmin, createTask, cancelTask, retryTask } = useAppData()
	const { page, pageSize, q, status } = tasksRoute.useSearch()
	const navigate = tasksRoute.useNavigate()

	const filtered = useMemo(() => filterTasks(tasks, q, status), [tasks, q, status])
	const openCount = useMemo(
		() => tasks.filter((t) => OPEN_STATUSES.includes(t.status)).length,
		[tasks],
	)
	const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1)
	const safePage = Math.min(page, lastPage)
	const hasFilter = q.length > 0 || (status !== null && status.length > 0)

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
			<Section
				title={
					hasFilter
						? `All tasks (${filtered.length} of ${tasks.length}) · ${openCount} open`
						: `All tasks (${tasks.length}) · ${openCount} open`
				}
			>
				<Stack spacing={2}>
					<TasksFilterBar
						q={q}
						status={status}
						openCount={openCount}
						onChange={(next) =>
							void navigate({
								search: (prev) => ({
									...prev,
									q: next.q,
									status: next.status,
									page: 0,
								}),
							})
						}
					/>
					{filtered.length === 0 && hasFilter ? (
						<Typography variant="body2" color="text.secondary">
							No tasks match your filter.
						</Typography>
					) : (
						<TasksPanel
							tasks={filtered}
							canManage={isAdmin}
							onCreate={createTask}
							onCancel={cancelTask}
							onRetry={retryTask}
							pagination={{
								page: safePage,
								pageSize,
								onPageChange: (next) =>
									void navigate({ search: (prev) => ({ ...prev, page: next }) }),
								onPageSizeChange: (next) =>
									void navigate({
										search: (prev) => ({
											...prev,
											pageSize: next as 10 | 25 | 50 | 100,
											page: 0,
										}),
									}),
							}}
						/>
					)}
				</Stack>
			</Section>
		</>
	)
}
