import { Box } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { Link } from '@tanstack/react-router'
import { useAppData } from '../AppContext.tsx'
import { TasksPanel } from '../components/TasksPanel.tsx'
import { Section } from './Root.tsx'

export function TasksPage() {
	const { tasks, isAdmin, createTask, cancelTask, retryTask } = useAppData()

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
					paginate
				/>
			</Section>
		</>
	)
}
