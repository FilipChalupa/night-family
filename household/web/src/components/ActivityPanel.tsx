import { Alert, Box, Paper, Stack, Typography } from '@mui/material'
import { BarChart } from '@mui/x-charts/BarChart'
import { PieChart } from '@mui/x-charts/PieChart'
import { useQuery } from '@tanstack/react-query'

interface DailyRow {
	date: string
	created: number
	completed: number
	failed: number
	tokens: number
}

interface StatusRow {
	status: string
	count: number
}

interface MemberRow {
	name: string
	completed: number
	failed: number
	tokens: number
}

interface StatsResponse {
	windowDays: number
	daily: DailyRow[]
	statusBreakdown: StatusRow[]
	byMember: MemberRow[]
}

const STATUS_COLOR: Record<string, string> = {
	new: '#a8b6e6',
	queued: '#a8b6e6',
	estimating: '#ffb37a',
	assigned: '#ffb37a',
	'in-progress': '#ffb37a',
	'in-review': '#ffb37a',
	'awaiting-merge': '#ffb37a',
	done: '#6cd28a',
	failed: '#ff8a8a',
	disconnected: '#ff8a8a',
}

export function ActivityPanel() {
	const { data, isLoading, error } = useQuery<StatsResponse>({
		queryKey: ['stats', 'tasks', { days: 30 }],
		queryFn: async () => {
			const r = await fetch('/api/stats/tasks?days=30')
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string }
				throw new Error(b.error ?? `HTTP ${r.status}`)
			}
			return (await r.json()) as StatsResponse
		},
		refetchInterval: 30_000,
	})

	if (isLoading) return <EmptyBox>Loading activity…</EmptyBox>
	if (error) return <Alert severity="error">{(error as Error).message}</Alert>
	if (!data) return <EmptyBox>No data.</EmptyBox>

	const totalTasks = data.statusBreakdown.reduce((sum, r) => sum + r.count, 0)

	return (
		<Stack spacing={2}>
			<Paper variant="outlined" sx={{ p: 2 }}>
				<Typography variant="body2" color="text.secondary" gutterBottom>
					Tasks per day · last {data.windowDays} days
				</Typography>
				{data.daily.every(
					(d) => d.created === 0 && d.completed === 0 && d.failed === 0,
				) ? (
					<EmptyBox>No task activity in this window yet.</EmptyBox>
				) : (
					<BarChart
						height={240}
						xAxis={[
							{ data: data.daily.map((d) => d.date.slice(5)), scaleType: 'band' },
						]}
						series={[
							{
								data: data.daily.map((d) => d.created),
								label: 'Created',
								color: '#4a87ff',
							},
							{
								data: data.daily.map((d) => d.completed),
								label: 'Completed',
								color: '#6cd28a',
							},
							{
								data: data.daily.map((d) => d.failed),
								label: 'Failed',
								color: '#ff8a8a',
							},
						]}
						margin={{ left: 40, right: 16, top: 16, bottom: 32 }}
					/>
				)}
			</Paper>

			<Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
				<Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 0 }}>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Status breakdown · {totalTasks} total
					</Typography>
					{totalTasks === 0 ? (
						<EmptyBox>No tasks yet.</EmptyBox>
					) : (
						<PieChart
							height={240}
							series={[
								{
									data: data.statusBreakdown.map((r, i) => ({
										id: r.status,
										value: r.count,
										label: r.status,
										color:
											STATUS_COLOR[r.status] ??
											`hsl(${(i * 47) % 360}, 60%, 60%)`,
									})),
									innerRadius: 50,
									paddingAngle: 1,
									cornerRadius: 2,
								},
							]}
							margin={{ left: 16, right: 16, top: 16, bottom: 16 }}
						/>
					)}
				</Paper>

				<Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 0 }}>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Throughput by member · last {data.windowDays} days
					</Typography>
					{data.byMember.length === 0 ? (
						<EmptyBox>Nobody finished a task in this window yet.</EmptyBox>
					) : (
						<BarChart
							height={240}
							layout="horizontal"
							yAxis={[{ data: data.byMember.map((m) => m.name), scaleType: 'band' }]}
							series={[
								{
									data: data.byMember.map((m) => m.completed),
									label: 'Completed',
									color: '#6cd28a',
								},
								{
									data: data.byMember.map((m) => m.failed),
									label: 'Failed',
									color: '#ff8a8a',
								},
							]}
							margin={{ left: 80, right: 16, top: 16, bottom: 32 }}
						/>
					)}
				</Paper>
			</Stack>

			<Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
				<Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 0 }}>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Tokens per day · last {data.windowDays} days
					</Typography>
					{data.daily.every((d) => d.tokens === 0) ? (
						<EmptyBox>No token usage reported in this window yet.</EmptyBox>
					) : (
						<BarChart
							height={240}
							xAxis={[
								{ data: data.daily.map((d) => d.date.slice(5)), scaleType: 'band' },
							]}
							series={[
								{
									data: data.daily.map((d) => d.tokens),
									label: 'Tokens',
									color: '#a78bfa',
									valueFormatter: formatTokens,
								},
							]}
							margin={{ left: 64, right: 16, top: 16, bottom: 32 }}
						/>
					)}
				</Paper>

				<Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 0 }}>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Tokens by member · last {data.windowDays} days
					</Typography>
					{data.byMember.every((m) => m.tokens === 0) ? (
						<EmptyBox>No token usage reported in this window yet.</EmptyBox>
					) : (
						<BarChart
							height={240}
							layout="horizontal"
							yAxis={[{ data: data.byMember.map((m) => m.name), scaleType: 'band' }]}
							series={[
								{
									data: data.byMember.map((m) => m.tokens),
									label: 'Tokens',
									color: '#a78bfa',
									valueFormatter: formatTokens,
								},
							]}
							margin={{ left: 80, right: 16, top: 16, bottom: 32 }}
						/>
					)}
				</Paper>
			</Stack>
		</Stack>
	)
}

function formatTokens(value: number | null): string {
	if (value === null) return ''
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
	return value.toLocaleString()
}

function EmptyBox({ children }: { children: React.ReactNode }) {
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
