import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Dashboard } from './routes/Dashboard.tsx'
import { RootLayout } from './routes/Root.tsx'
import { TasksPage } from './routes/TasksPage.tsx'

const rootRoute = createRootRoute({ component: RootLayout })

const dashboardRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: Dashboard,
})

const tasksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/tasks',
	component: TasksPage,
})

const routeTree = rootRoute.addChildren([dashboardRoute, tasksRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}
