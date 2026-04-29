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

const ALLOWED_PAGE_SIZES = [10, 25, 50, 100] as const
type PageSize = (typeof ALLOWED_PAGE_SIZES)[number]

interface TasksSearch {
	page: number
	pageSize: PageSize
}

export const tasksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/tasks',
	component: TasksPage,
	validateSearch: (search: Record<string, unknown>): TasksSearch => {
		const rawPage = Number(search['page'])
		const page = Number.isFinite(rawPage) && rawPage >= 0 ? Math.floor(rawPage) : 0
		const rawSize = Number(search['pageSize'])
		const pageSize = (
			ALLOWED_PAGE_SIZES.includes(rawSize as PageSize) ? rawSize : 25
		) as PageSize
		return { page, pageSize }
	},
})

const routeTree = rootRoute.addChildren([dashboardRoute, tasksRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}
