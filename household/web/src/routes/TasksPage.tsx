import { Box } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { Link } from '@tanstack/react-router'
import { useAppData } from '../AppContext.tsx'
import { TasksPanel } from '../components/TasksPanel.tsx'
import { tasksRoute } from '../router.tsx'
import { Section } from './Root.tsx'

export function TasksPage() {
	const { tasks, isAdmin, createTask, cancelTask, retryTask } = useAppData()
	const { page, pageSize } = tasksRoute.useSearch()
	const navigate = tasksRoute.useNavigate()

	const lastPage = Math.max(0, Math.ceil(tasks.length / pageSize) - 1)
	const safePage = Math.min(page, lastPage)

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
			<Section title={`All tasks (${tasks.length})`}>
				<TasksPanel
					tasks={tasks}
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
			</Section>
		</>
	)
}
