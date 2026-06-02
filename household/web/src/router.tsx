import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material'
import {
	createRootRoute,
	createRoute,
	createRouter,
	lazyRouteComponent,
	type ErrorComponentProps,
} from '@tanstack/react-router'
import { Dashboard } from './routes/Dashboard.tsx'
import { RootLayout } from './routes/Root.tsx'
import type { TaskStatus } from './types.ts'

// The shell (`RootLayout`) and the landing page (`Dashboard`) load eagerly so
// the first paint has no extra round-trip. Every other route's component is
// code-split via `lazyRouteComponent` — this keeps heavy, page-specific deps
// (e.g. `react-markdown` in TaskDetail) out of the initial bundle. Charts
// (`@mui/x-charts`) live in `ActivityPanel`, which the Dashboard lazy-loads on
// its own, so they split out too.

const rootRoute = createRootRoute({ component: RootLayout })

const dashboardRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: Dashboard,
})

const ALLOWED_PAGE_SIZES = [10, 25, 50, 100] as const
type PageSize = (typeof ALLOWED_PAGE_SIZES)[number]

const ALL_TASK_STATUSES: ReadonlyArray<TaskStatus> = [
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
	'done',
	'failed',
]

interface TasksSearch {
	page: number
	pageSize: PageSize
	/** Free-text query against task title / description / repo. Trimmed; empty = no filter. */
	q: string
	/** Status whitelist. `null` = no filter (show all). */
	status: TaskStatus[] | null
	/** Cross-cutting quick filter. `'human'` = only tasks waiting on a human; `null` = off. */
	waiting: 'human' | null
}

export const tasksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/tasks',
	component: lazyRouteComponent(() => import('./routes/TasksPage.tsx'), 'TasksPage'),
	validateSearch: (search: Record<string, unknown>): TasksSearch => {
		const rawPage = Number(search['page'])
		const page = Number.isFinite(rawPage) && rawPage >= 0 ? Math.floor(rawPage) : 0
		const rawSize = Number(search['pageSize'])
		const pageSize = (
			ALLOWED_PAGE_SIZES.includes(rawSize as PageSize) ? rawSize : 25
		) as PageSize
		const q = typeof search['q'] === 'string' ? search['q'].slice(0, 200).trim() : ''
		// `status` may arrive as either an array (TanStack's default serialization)
		// or a comma-separated string (for hand-typed URLs). Missing param = `null`
		// (no filter); empty list = `[]` (filter explicitly matches none).
		const rawStatus = search['status']
		let status: TaskStatus[] | null = null
		if (Array.isArray(rawStatus)) {
			status = rawStatus.filter(
				(s): s is TaskStatus =>
					typeof s === 'string' && ALL_TASK_STATUSES.includes(s as TaskStatus),
			)
		} else if (typeof rawStatus === 'string') {
			status = rawStatus
				.split(',')
				.map((s) => s.trim())
				.filter((s): s is TaskStatus => ALL_TASK_STATUSES.includes(s as TaskStatus))
		}
		const waiting = search['waiting'] === 'human' ? 'human' : null
		return { page, pageSize, q, status, waiting }
	},
})

export const taskDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/tasks/$taskId',
	component: lazyRouteComponent(() => import('./routes/TaskDetailPage.tsx'), 'TaskDetailPage'),
})

export const memberDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/members/$memberId',
	component: lazyRouteComponent(
		() => import('./routes/MemberDetailPage.tsx'),
		'MemberDetailPage',
	),
})

// GitHub repo slugs are always `owner/name` — two path segments rather than
// one URL-encoded slug. Keeps the URL readable (`/repos/foo/bar`) and avoids
// `%2F` round-trip footguns with TanStack Router's URL parser.
export const repoDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/repos/$owner/$name',
	component: lazyRouteComponent(() => import('./routes/RepoDetailPage.tsx'), 'RepoDetailPage'),
})

export const docsIndexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/docs',
	component: lazyRouteComponent(() => import('./routes/Docs.tsx'), 'DocsIndex'),
})

export const docDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/docs/$slug',
	component: lazyRouteComponent(() => import('./routes/Docs.tsx'), 'DocDetailPage'),
})

const routeTree = rootRoute.addChildren([
	dashboardRoute,
	tasksRoute,
	taskDetailRoute,
	memberDetailRoute,
	repoDetailRoute,
	docsIndexRoute,
	docDetailRoute,
])

function RouteError({ error, reset }: ErrorComponentProps) {
	return (
		<Stack spacing={2} sx={{ py: 2 }}>
			<Alert severity="error" variant="outlined">
				<Typography sx={{ fontWeight: 600 }} gutterBottom>
					Something went wrong rendering this page.
				</Typography>
				<Typography
					variant="body2"
					component="pre"
					sx={{
						fontFamily: 'monospace',
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						m: 0,
					}}
				>
					{error.message}
				</Typography>
			</Alert>
			<Button
				variant="outlined"
				size="small"
				sx={{ alignSelf: 'flex-start' }}
				onClick={reset}
			>
				Retry
			</Button>
		</Stack>
	)
}

function RoutePending() {
	return (
		<Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
			<CircularProgress size={28} />
		</Box>
	)
}

export const router = createRouter({
	routeTree,
	defaultErrorComponent: RouteError,
	// Fetch a route's code-split chunk on hover/focus so navigation usually
	// has it ready by click — hides the lazy-load latency for the common case.
	defaultPreload: 'intent',
	// Shown only if a chunk is still loading when the route actually renders.
	defaultPendingComponent: RoutePending,
})

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}
