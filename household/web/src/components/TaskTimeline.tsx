import { Alert, Box, Chip, Stack, Typography } from '@mui/material'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { EmptyState, LoadingRows } from '../routes/Root.tsx'
import { formatDuration, formatTokens } from '../format.ts'
import type { TaskLogEvent } from '../types.ts'

/**
 * Structured timeline of a task's agent events — one human-readable line per
 * event on a colour-coded rail, with the raw JSON tucked behind a toggle.
 * Shared by the task detail page and the tasks-table event dialog so the two
 * never drift (they used to: one was a timeline, the other a JSON dump).
 */
export function TaskTimeline({ taskId, limit = 200 }: { taskId: string; limit?: number }) {
	const [newestFirst, setNewestFirst] = useState(false)
	const { data: events, error } = useQuery<TaskLogEvent[]>({
		queryKey: ['task-events', taskId, limit],
		queryFn: async () => {
			const r = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/events?limit=${limit}`)
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string }
				throw new Error(b.error ?? `HTTP ${r.status}`)
			}
			const body = (await r.json()) as { events: TaskLogEvent[] }
			return body.events
		},
	})

	if (error) return <Alert severity="error">{(error as Error).message}</Alert>
	if (!events) return <LoadingRows />
	if (events.length === 0) {
		return (
			<EmptyState>
				No events recorded for this task. Either the agent never sent any (e.g. it crashed
				before emit) or they were purged after 90 days.
			</EmptyState>
		)
	}

	// The events endpoint returns newest-first; a timeline reads oldest→newest,
	// so reverse to chronological order (this also makes first/last and the
	// inter-step deltas below come out positive).
	const ordered = [...events].reverse()
	const first = new Date(ordered[0]!.ts).getTime()
	const last = new Date(ordered[ordered.length - 1]!.ts).getTime()
	const totalTokens = ordered.reduce((max, e) => {
		if (e.kind !== 'usage') return max
		const p = (e.payload ?? {}) as Record<string, unknown>
		return Math.max(max, num(p.input) + num(p.output))
	}, 0)

	return (
		<Stack spacing={1}>
			<Stack
				direction="row"
				spacing={1}
				sx={{ flexWrap: 'wrap', alignItems: 'baseline', mb: 0.5 }}
			>
				<Typography variant="body2" color="text.secondary">
					{events.length} events
				</Typography>
				{last > first ? (
					<Typography variant="body2" color="text.secondary">
						· {formatDuration((last - first) / 1000)} elapsed
					</Typography>
				) : null}
				{totalTokens > 0 ? (
					<Typography variant="body2" color="text.secondary">
						· {formatTokens(totalTokens)} tokens
					</Typography>
				) : null}
				<Box sx={{ flex: 1 }} />
				<Chip
					label={newestFirst ? 'Newest first' : 'Oldest first'}
					size="small"
					variant="outlined"
					onClick={() => setNewestFirst((v) => !v)}
					sx={{ cursor: 'pointer' }}
				/>
			</Stack>

			{(newestFirst ? [...ordered].reverse() : ordered).map((e) => {
				// Delta is time since the chronological predecessor, regardless of
				// display order, so it stays meaningful when reversed.
				const chronoIdx = ordered.indexOf(e)
				const prevTs = chronoIdx > 0 ? new Date(ordered[chronoIdx - 1]!.ts).getTime() : null
				const deltaS = prevTs !== null ? (new Date(e.ts).getTime() - prevTs) / 1000 : null
				const { summary, tone } = summarizeEvent(e)
				const meta = kindMeta(e.kind)
				return (
					<Box
						key={e.seq}
						sx={{
							p: 1.25,
							border: 1,
							borderColor: 'divider',
							borderLeft: 3,
							borderLeftColor: `${meta.color}.main`,
							borderRadius: 1,
							backgroundColor: 'background.default',
						}}
					>
						<Stack
							direction="row"
							spacing={1}
							sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
						>
							<Chip
								label={meta.label}
								size="small"
								color={meta.color}
								variant="outlined"
							/>
							<Typography
								variant="body2"
								sx={{ wordBreak: 'break-word', flex: 1, minWidth: 0 }}
								color={tone === 'error' ? 'error' : 'text.primary'}
							>
								{summary}
							</Typography>
							<Typography variant="caption" color="text.secondary">
								{new Date(e.ts).toLocaleTimeString()}
								{deltaS !== null && deltaS >= 1
									? ` · +${formatDuration(deltaS)}`
									: ''}
							</Typography>
						</Stack>
						<Box
							component="details"
							sx={{
								mt: 0.5,
								'& summary': {
									cursor: 'pointer',
									fontSize: '0.72rem',
									color: 'text.disabled',
									listStyle: 'none',
								},
							}}
						>
							<Box component="summary">raw · seq {e.seq}</Box>
							<Box
								component="pre"
								sx={{
									m: 0,
									mt: 0.5,
									fontFamily: 'monospace',
									fontSize: '0.74rem',
									whiteSpace: 'pre-wrap',
									wordBreak: 'break-word',
									color: 'text.secondary',
								}}
							>
								{JSON.stringify(e.payload, null, 2)}
							</Box>
						</Box>
					</Box>
				)
			})}
		</Stack>
	)
}

type ChipColor = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'info'

/** Per-kind label + accent colour for the timeline. */
export function kindMeta(kind: string): { label: string; color: ChipColor } {
	switch (kind) {
		case 'tool_call':
			return { label: 'tool', color: 'info' }
		case 'file_edited':
			return { label: 'edit', color: 'secondary' }
		case 'commit':
			return { label: 'commit', color: 'success' }
		case 'usage':
			return { label: 'tokens', color: 'default' }
		case 'rebase':
			return { label: 'rebase', color: 'warning' }
		case 'preview':
			return { label: 'preview', color: 'primary' }
		case 'log':
			return { label: 'log', color: 'default' }
		default:
			return { label: kind, color: 'default' }
	}
}

/** A one-line human summary of an event payload. */
export function summarizeEvent(e: TaskLogEvent): { summary: string; tone?: 'error' } {
	const p = (e.payload ?? {}) as Record<string, unknown>
	switch (e.kind) {
		case 'tool_call': {
			const tool = str(p.tool) || 'tool'
			const arg = argPreview(p.input)
			return { summary: arg ? `${tool}(${arg})` : tool }
		}
		case 'log': {
			if (typeof p.message === 'string') {
				return {
					summary: p.message,
					...(p.isError === true ? { tone: 'error' as const } : {}),
				}
			}
			if (typeof p.tool === 'string') {
				const out = str(p.output)
				return {
					summary: out ? `${p.tool} → ${truncate(out, 140)}` : String(p.tool),
					...(p.isError === true ? { tone: 'error' as const } : {}),
				}
			}
			return { summary: truncate(oneLineJson(p), 160) }
		}
		case 'usage': {
			const cache = num(p.cacheRead) + num(p.cacheCreation)
			const extra = cache > 0 ? ` · ${formatTokens(cache)} cache` : ''
			return {
				summary: `${formatTokens(num(p.input))} in · ${formatTokens(num(p.output))} out${extra}`,
			}
		}
		case 'commit':
			return { summary: `${str(p.sha).slice(0, 7) || '?'} on ${str(p.branch) || '?'}` }
		case 'file_edited':
			return { summary: str(p.path) || oneLineJson(p) }
		case 'rebase':
			return { summary: str(p.outcome) || truncate(oneLineJson(p), 160) }
		case 'preview':
			return { summary: str(p.status) || str(p.url) || truncate(oneLineJson(p), 160) }
		default:
			return { summary: truncate(oneLineJson(p), 160) }
	}
}

/** Short preview of a tool's most salient arg (command / path / url). */
function argPreview(input: unknown): string {
	if (!input || typeof input !== 'object') return ''
	const o = input as Record<string, unknown>
	const salient = o.command ?? o.path ?? o.pr_url ?? o.issue_url ?? o.query
	if (typeof salient === 'string') return truncate(salient, 80)
	return truncate(oneLineJson(o), 80)
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : ''
}
function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + '…' : s
}
function oneLineJson(v: unknown): string {
	try {
		return JSON.stringify(v) ?? ''
	} catch {
		return String(v)
	}
}
