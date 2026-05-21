import {
	Box,
	Chip,
	Paper,
	Stack,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	Tooltip,
	Typography,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { Link as RouterLink } from '@tanstack/react-router'
import { useAppData } from '../AppContext.tsx'
import { RefreshReposButton } from '../components/RefreshReposButton.tsx'
import { repoDetailRoute } from '../router.tsx'
import { relativeTime } from '../time.ts'
import type { MemberSnapshot, TaskRecord } from '../types.ts'
import { EmptyState, Section } from './Root.tsx'

/**
 * Per-repo detail view. The natural debugging target when a task fails to
 * dispatch: pick the repo, see who covers it, refresh anyone whose allowlist
 * looks stale or who reported an error on their last refresh.
 *
 * Data source is the live `members` snapshot from AppContext (same WS stream
 * that powers the dashboard) — no extra endpoint needed. A repo is "covered"
 * by a member when its `repos` allowlist is `null` (unconstrained) or
 * contains the slug verbatim.
 */
export function RepoDetailPage() {
	const { owner, name } = repoDetailRoute.useParams()
	const slug = `${owner}/${name}`
	const githubUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
	const { members, tasks, isAdmin } = useAppData()

	const rows = members.map((m) => ({
		member: m,
		coverage: coverageFor(m, slug),
	}))
	const covered = rows.filter((r) => r.coverage === 'covered')
	const uncovered = rows.filter((r) => r.coverage === 'not-covered')
	const unconstrained = rows.filter((r) => r.coverage === 'unconstrained')
	const queued = tasks.filter((t) => t.repo === slug && t.status === 'queued')

	return (
		<>
			<Box sx={{ mb: 2 }}>
				<RouterLink
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
				</RouterLink>
			</Box>

			<Section title="Repo">
				<Paper variant="outlined" sx={{ p: 2 }}>
					<Stack spacing={1}>
						<Typography
							variant="h6"
							component="code"
							sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
						>
							{slug}
						</Typography>
						<Stack direction="row" spacing={3} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
							<a
								href={githubUrl}
								target="_blank"
								rel="noopener noreferrer"
								style={{
									color: 'inherit',
									display: 'inline-flex',
									alignItems: 'center',
									gap: 4,
									fontSize: '0.875rem',
								}}
							>
								Open on GitHub
								<OpenInNewIcon fontSize="inherit" />
							</a>
							<Typography variant="body2" color="text.secondary">
								{covered.length} members cover this repo
								{unconstrained.length > 0
									? ` (+${unconstrained.length} unconstrained)`
									: ''}
								{uncovered.length > 0 ? `, ${uncovered.length} don't` : ''}.
							</Typography>
						</Stack>
					</Stack>
				</Paper>
			</Section>

			<Section title={`Queued tasks (${queued.length})`}>
				<QueuedForRepo
					tasks={queued}
					coveredCount={covered.length + unconstrained.length}
				/>
			</Section>

			<Section title={`Members (${members.length})`}>
				{members.length === 0 ? (
					<EmptyState>No connected members yet.</EmptyState>
				) : (
					<TableContainer component={Paper} variant="outlined">
						<Table size="small">
							<TableHead>
								<TableRow>
									<TableCell>Name</TableCell>
									<TableCell>Status</TableCell>
									<TableCell>Allowlist coverage</TableCell>
									<TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
										Connected
									</TableCell>
									{isAdmin ? <TableCell align="right">Actions</TableCell> : null}
								</TableRow>
							</TableHead>
							<TableBody>
								{rows.map(({ member, coverage }) => (
									<TableRow key={member.sessionId} hover>
										<TableCell>
											<RouterLink
												to="/members/$memberId"
												params={{ memberId: member.memberId }}
												style={{ color: 'inherit', textDecoration: 'none' }}
											>
												<Box>
													<Typography
														component="span"
														color="text.secondary"
														variant="body2"
													>
														Night{' '}
													</Typography>
													<Typography
														component="span"
														sx={{ fontWeight: 600 }}
													>
														{member.displayName || member.memberName}
													</Typography>
												</Box>
												<Typography
													variant="caption"
													color="text.secondary"
												>
													@{member.memberName}
												</Typography>
											</RouterLink>
										</TableCell>
										<TableCell>
											<Chip
												label={member.status}
												size="small"
												color={statusColor(member.status)}
												variant="outlined"
											/>
										</TableCell>
										<TableCell>
											<CoverageChip coverage={coverage} />
										</TableCell>
										<TableCell
											sx={{ display: { xs: 'none', sm: 'table-cell' } }}
										>
											<Tooltip title={member.connectedAt}>
												<Typography variant="body2" color="text.secondary">
													{relativeTime(member.connectedAt)}
												</Typography>
											</Tooltip>
										</TableCell>
										{isAdmin ? (
											<TableCell align="right">
												<RefreshReposButton
													memberId={member.memberId}
													disabled={member.status === 'offline'}
													lastError={member.lastReposError}
												/>
											</TableCell>
										) : null}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</TableContainer>
				)}
			</Section>
		</>
	)
}

function QueuedForRepo({ tasks, coveredCount }: { tasks: TaskRecord[]; coveredCount: number }) {
	if (tasks.length === 0) {
		return <EmptyState>No queued tasks for this repo.</EmptyState>
	}
	return (
		<TableContainer component={Paper} variant="outlined">
			<Table size="small">
				<TableHead>
					<TableRow>
						<TableCell>Title</TableCell>
						<TableCell>Kind</TableCell>
						<TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
							Queued
						</TableCell>
						<TableCell />
					</TableRow>
				</TableHead>
				<TableBody>
					{tasks.map((t) => (
						<TableRow key={t.id} hover>
							<TableCell>
								<RouterLink
									to="/tasks/$taskId"
									params={{ taskId: t.id }}
									style={{ color: 'inherit', textDecoration: 'none' }}
								>
									<Typography variant="body2" sx={{ fontWeight: 500 }}>
										{t.title}
									</Typography>
								</RouterLink>
							</TableCell>
							<TableCell>
								<Chip
									label={t.kind}
									size="small"
									variant="outlined"
									color="default"
								/>
							</TableCell>
							<TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>
								<Tooltip title={t.createdAt}>
									<Typography variant="body2" color="text.secondary">
										{relativeTime(t.createdAt)}
									</Typography>
								</Tooltip>
							</TableCell>
							<TableCell>
								{coveredCount === 0 ? (
									<Tooltip title="No connected member's allowlist covers this repo. Dispatch is blocked until someone refreshes or gains push access.">
										<Chip
											label="no member covers"
											size="small"
											color="warning"
											variant="filled"
										/>
									</Tooltip>
								) : null}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableContainer>
	)
}

type Coverage = 'covered' | 'not-covered' | 'unconstrained'

function coverageFor(member: MemberSnapshot, slug: string): Coverage {
	if (member.repos === null) return 'unconstrained'
	return member.repos.includes(slug) ? 'covered' : 'not-covered'
}

function CoverageChip({ coverage }: { coverage: Coverage }) {
	switch (coverage) {
		case 'covered':
			return (
				<Tooltip title="This repo is in the member's GitHub-derived allowlist.">
					<Chip label="covers" size="small" color="success" variant="outlined" />
				</Tooltip>
			)
		case 'unconstrained':
			return (
				<Tooltip title="Member runs without a repo allowlist — accepts tasks for any repo.">
					<Chip label="unconstrained" size="small" color="success" variant="outlined" />
				</Tooltip>
			)
		case 'not-covered':
			return (
				<Tooltip title="Member's allowlist doesn't include this repo. If you just granted access, click Refresh repos.">
					<Chip label="not covered" size="small" color="warning" variant="outlined" />
				</Tooltip>
			)
	}
}

function statusColor(status: MemberSnapshot['status']): 'success' | 'warning' | 'default' {
	switch (status) {
		case 'idle':
			return 'success'
		case 'busy':
			return 'warning'
		case 'offline':
			return 'default'
	}
}
