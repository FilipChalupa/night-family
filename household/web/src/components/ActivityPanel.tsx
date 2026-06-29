import { Alert, Paper, Stack, Typography } from '@mui/material'
import { BarChart } from '@mui/x-charts/BarChart'
import { LineChart } from '@mui/x-charts/LineChart'
import { PieChart } from '@mui/x-charts/PieChart'
import { useQuery } from '@tanstack/react-query'
import { cumulative, formatTokens } from '../format.ts'
import { EmptyState } from '../routes/Root.tsx'

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

interface RepoRow {
	repo: string | null
	completed: number
	failed: number
	tokens: number
}

interface StatsResponse {
	windowDays: number
	daily: DailyRow[]
	statusBreakdown: StatusRow[]
	byMember: MemberRow[]
	byRepo: RepoRow[]
}

interface PreviewStats {
	running: number
	queued: number
	connectedTunnels: number
	recent: {
		days: number
		created: number
		done: number
		failed: number
		wakes: number
		sleeps: number
		crashes: number
		avgWakeMs: number | null
	}
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

	const { data: preview } = useQuery<PreviewStats>({
		queryKey: ['stats', 'preview'],
		queryFn: async () => {
			const r = await fetch('/api/stats/preview')
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			return (await r.json()) as PreviewStats
		},
		refetchInterval: 15_000,
	})

	if (isLoading) return <EmptyState>Loading activity…</EmptyState>
	if (error) return <Alert severity="error">{(error as Error).message}</Alert>
	if (!data) return <EmptyState>No data.</EmptyState>

	const totalTasks = data.statusBreakdown.reduce((sum, r) => sum + r.count, 0)

	return (
		<Stack spacing={2}>
			{preview ? (
				<Paper variant="outlined" sx={{ p: 2 }}>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Previews
					</Typography>
					<Stack direction="row" spacing={3} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
						<Stat label="Running" value={preview.running} />
						<Stat label="Queued" value={preview.queued} />
						<Stat label="Tunnels" value={preview.connectedTunnels} />
						<Stat
							label={`Done · ${preview.recent.days}d`}
							value={preview.recent.done}
						/>
						<Stat
							label={`Failed · ${preview.recent.days}d`}
							value={preview.recent.failed}
							color={preview.recent.failed > 0 ? 'error.main' : undefined}
						/>
						<Stat
							label={`Wakes · ${preview.recent.days}d`}
							value={preview.recent.wakes}
						/>
						<Stat
							label="Avg wake"
							value={
								preview.recent.avgWakeMs === null
									? '—'
									: `${(preview.recent.avgWakeMs / 1000).toFixed(1)}s`
							}
						/>
						{preview.recent.crashes > 0 ? (
							<Stat
								label={`Crashes · ${preview.recent.days}d`}
								value={preview.recent.crashes}
								color="error.main"
							/>
						) : null}
					</Stack>
				</Paper>
			) : null}
			<Paper variant="outlined" sx={{ p: 2 }}>
				<Typography variant="body2" color="text.secondary" gutterBottom>
					Tasks per day · last {data.windowDays} days
				</Typography>
				{data.daily.every((d) => d.created === 0 && d.completed === 0 && d.failed === 0) ? (
					<EmptyState>No task activity in this window yet.</EmptyState>
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
						<EmptyState>No tasks yet.</EmptyState>
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
						<EmptyState>Nobody finished a task in this window yet.</EmptyState>
					) : (
						<BarChart
							height={240}
							layout="horizontal"
							yAxis={[
								{
									data: data.byMember.map((m) => m.name),
									scaleType: 'band',
									width: 'auto',
								},
							]}
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
							margin={{ right: 16, top: 16, bottom: 32 }}
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
						<EmptyState>No token usage reported in this window yet.</EmptyState>
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
						<EmptyState>No token usage reported in this window yet.</EmptyState>
					) : (
						<BarChart
							height={240}
							layout="horizontal"
							yAxis={[
								{
									data: data.byMember.map((m) => m.name),
									scaleType: 'band',
									width: 'auto',
								},
							]}
							series={[
								{
									data: data.byMember.map((m) => m.tokens),
									label: 'Tokens',
									color: '#a78bfa',
									valueFormatter: formatTokens,
								},
							]}
							margin={{ right: 16, top: 16, bottom: 32 }}
						/>
					)}
				</Paper>
			</Stack>

			<Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
				<Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 0 }}>
					<Stack
						direction="row"
						spacing={1}
						sx={{ alignItems: 'baseline', flexWrap: 'wrap', mb: 0.5 }}
					>
						<Typography variant="body2" color="text.secondary">
							Cumulative spend · last {data.windowDays} days
						</Typography>
						{(() => {
							const total = data.daily.reduce((sum, d) => sum + d.tokens, 0)
							const perDay = total / Math.max(data.daily.length, 1)
							return total > 0 ? (
								<Typography variant="caption" color="text.secondary">
									· {formatTokens(total)} total · ~{formatTokens(perDay)}/day
								</Typography>
							) : null
						})()}
					</Stack>
					{data.daily.every((d) => d.tokens === 0) ? (
						<EmptyState>No token usage reported in this window yet.</EmptyState>
					) : (
						<LineChart
							height={240}
							xAxis={[
								{
									data: data.daily.map((d) => d.date.slice(5)),
									scaleType: 'point',
								},
							]}
							series={[
								{
									data: cumulative(data.daily.map((d) => d.tokens)),
									label: 'Cumulative tokens',
									color: '#a78bfa',
									area: true,
									showMark: false,
									valueFormatter: formatTokens,
								},
							]}
							margin={{ left: 64, right: 16, top: 16, bottom: 32 }}
						/>
					)}
				</Paper>

				<Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 0 }}>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Tokens by repo · last {data.windowDays} days
					</Typography>
					{data.byRepo.every((r) => r.tokens === 0) ? (
						<EmptyState>No token usage reported in this window yet.</EmptyState>
					) : (
						<BarChart
							height={240}
							layout="horizontal"
							yAxis={[
								{
									data: data.byRepo.map((r) => r.repo ?? '(no repo)'),
									scaleType: 'band',
									width: 'auto',
								},
							]}
							series={[
								{
									data: data.byRepo.map((r) => r.tokens),
									label: 'Tokens',
									color: '#34d399',
									valueFormatter: formatTokens,
								},
							]}
							margin={{ right: 16, top: 16, bottom: 32 }}
						/>
					)}
				</Paper>
			</Stack>
		</Stack>
	)
}

function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
	return (
		<Stack spacing={0}>
			<Typography variant="h6" sx={{ fontWeight: 600, color }}>
				{value}
			</Typography>
			<Typography variant="caption" color="text.secondary">
				{label}
			</Typography>
		</Stack>
	)
}
