import { Alert, Button, Stack, Typography } from '@mui/material'
import {
	createRootRoute,
	createRoute,
	createRouter,
	type ErrorComponentProps,
} from '@tanstack/react-router'
import { Dashboard } from './routes/Dashboard.tsx'
import { DocPageView, DocsIndex } from './routes/Docs.tsx'
import { MemberDetailPage } from './routes/MemberDetailPage.tsx'
import { RepoDetailPage } from './routes/RepoDetailPage.tsx'
import { RootLayout } from './routes/Root.tsx'
import { TaskDetailPage } from './routes/TaskDetailPage.tsx'
import { TasksPage } from './routes/TasksPage.tsx'
import type { TaskStatus } from './types.ts'

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
	component: TasksPage,
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
	component: TaskDetailPage,
})

export const memberDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/members/$memberId',
	component: MemberDetailPage,
})

// GitHub repo slugs are always `owner/name` — two path segments rather than
// one URL-encoded slug. Keeps the URL readable (`/repos/foo/bar`) and avoids
// `%2F` round-trip footguns with TanStack Router's URL parser.
export const repoDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/repos/$owner/$name',
	component: RepoDetailPage,
})

export const docsIndexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/docs',
	component: DocsIndex,
})

export const docDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/docs/$slug',
	component: function DocDetailRouteComponent() {
		const { slug } = docDetailRoute.useParams()
		return <DocPageView slug={slug} />
	},
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

export const router = createRouter({ routeTree, defaultErrorComponent: RouteError })

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}
