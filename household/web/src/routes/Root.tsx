import { Box, Button, Container, Stack, Typography } from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { AppDataProvider, type Health } from '../AppContext.tsx'
import { ConnectionStatus } from '../components/ConnectionStatus.tsx'
import { InstallButton } from '../components/InstallButton.tsx'
import { NotificationsToggle } from '../components/NotificationsToggle.tsx'
import { UpdateToast } from '../components/UpdateToast.tsx'
import { useTaskNotifications } from '../hooks/useTaskNotifications.ts'
import { useUiStream } from '../hooks/useUiStream.ts'
import type { CurrentUser, TaskKind } from '../types.ts'

export function RootLayout() {
	const { data: health = null } = useQuery<Health | null>({
		queryKey: ['health'],
		queryFn: async () => {
			const r = await fetch('/health')
			return r.ok ? ((await r.json()) as Health) : null
		},
		refetchInterval: 30_000,
	})
	const { data: me } = useQuery<CurrentUser | null>({
		queryKey: ['me'],
		queryFn: async () => {
			const r = await fetch('/api/me')
			return r.ok ? ((await r.json()) as CurrentUser) : null
		},
	})
	const shouldConnectUiStream = me?.authenticated === true || me?.require_ui_login !== true
	const { members, tasks, connected, householdProtocolVersion, lastMessageAt } =
		useUiStream(shouldConnectUiStream)
	useTaskNotifications(tasks)

	const isAdmin =
		(me?.authenticated === true && me.role === 'admin') || me?.oauth_configured === false
	const canSeeUsers = me?.authenticated === true
	const requiresLogin = me?.require_ui_login === true
	const isLoggedOutWithRequiredLogin = requiresLogin && me?.authenticated === false

	const logout = async () => {
		await fetch('/auth/logout', { method: 'POST' })
		window.location.reload()
	}

	if (!me) {
		return (
			<Container maxWidth="lg" sx={{ py: 3, px: { xs: 1.5, sm: 3 } }}>
				<EmptyState>Loading dashboard…</EmptyState>
			</Container>
		)
	}

	if (isLoggedOutWithRequiredLogin) {
		return (
			<Container
				maxWidth="sm"
				sx={{ minHeight: '60vh', display: 'flex', alignItems: 'center' }}
			>
				<Stack spacing={2} sx={{ width: '100%' }}>
					<Typography variant="h4" component="h1">
						{health?.household ?? 'Night Family'}
					</Typography>
					<Typography color="text.secondary">
						Dashboard access requires GitHub sign-in.
					</Typography>
					<Button
						variant="contained"
						component="a"
						href="/auth/github?redirect_to=/"
						sx={{ alignSelf: 'flex-start' }}
					>
						Sign in with GitHub
					</Button>
				</Stack>
			</Container>
		)
	}

	const createTask = async (input: {
		kind: TaskKind
		title: string
		description: string
		repo: string | null
	}) => {
		const res = await fetch('/api/tasks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
		})
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string }
			throw new Error(body.error ?? `HTTP ${res.status}`)
		}
	}

	const cancelTask = async (id: string) => {
		const r = await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' })
		if (!r.ok) {
			const b = (await r.json().catch(() => ({}))) as { error?: string }
			throw new Error(b.error ?? `HTTP ${r.status}`)
		}
	}

	const retryTask = async (id: string) => {
		const r = await fetch(`/api/tasks/${id}/retry`, { method: 'POST' })
		if (!r.ok) {
			const b = (await r.json().catch(() => ({}))) as { error?: string }
			throw new Error(b.error ?? `HTTP ${r.status}`)
		}
	}

	return (
		<AppDataProvider
			value={{
				me,
				health,
				members,
				tasks,
				connected,
				lastMessageAt,
				householdProtocolVersion,
				isAdmin,
				canSeeUsers,
				createTask,
				cancelTask,
				retryTask,
			}}
		>
			<Container maxWidth="lg" sx={{ py: 3, px: { xs: 1.5, sm: 3 } }}>
				<Stack
					direction={{ xs: 'column', md: 'row' }}
					spacing={1.5}
					sx={{
						justifyContent: 'space-between',
						alignItems: { xs: 'flex-start', md: 'baseline' },
						pb: 1.5,
						mb: 3,
						borderBottom: 1,
						borderColor: 'divider',
					}}
				>
					<Box>
						<Stack
							direction="row"
							spacing={1.25}
							sx={{ alignItems: 'center', flexWrap: 'wrap' }}
						>
							<Typography
								variant="h6"
								component={Link}
								to="/"
								sx={{
									color: 'text.primary',
									textDecoration: 'none',
								}}
							>
								{health?.household ?? 'Night Family'}
							</Typography>
							{shouldConnectUiStream ? (
								<ConnectionStatus
									connected={connected}
									lastMessageAt={lastMessageAt}
								/>
							) : null}
						</Stack>
						<Typography variant="body2" color="text.secondary">
							{health
								? `uptime ${formatUptime(health.uptimeSec)} · status ${health.status}`
								: 'connecting…'}
						</Typography>
					</Box>
					<Stack
						direction="row"
						spacing={1.5}
						sx={{ alignItems: 'center', flexWrap: 'wrap' }}
					>
						<InstallButton />
						<NotificationsToggle />
						{me.authenticated ? (
							<>
								<Typography
									variant="body2"
									color="text.secondary"
									sx={{ display: { xs: 'none', sm: 'inline' } }}
								>
									signed in as <strong>{me.username}</strong> · role {me.role}
								</Typography>
								<Button
									variant="outlined"
									size="small"
									onClick={() => void logout()}
								>
									Sign out
								</Button>
							</>
						) : me.oauth_configured ? (
							<Button
								variant="contained"
								size="small"
								component="a"
								href="/auth/github?redirect_to=/"
							>
								Sign in with GitHub
							</Button>
						) : null}
					</Stack>
				</Stack>

				<Outlet />
			</Container>
			<UpdateToast />
		</AppDataProvider>
	)
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<Box sx={{ mb: 4 }}>
			<Typography
				variant="overline"
				component="h2"
				sx={{ display: 'block', mb: 1.5, color: 'text.secondary', letterSpacing: '0.08em' }}
			>
				{title}
			</Typography>
			{children}
		</Box>
	)
}

export function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<Box
			sx={{
				p: 3,
				border: 1,
				borderStyle: 'dashed',
				borderColor: 'divider',
				borderRadius: 2,
				color: 'text.secondary',
				textAlign: 'center',
			}}
		>
			{children}
		</Box>
	)
}

function formatUptime(sec: number): string {
	if (sec < 60) return `${sec}s`
	const m = Math.floor(sec / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	const rem = m % 60
	return `${h}h ${rem}m`
}
