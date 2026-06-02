import { Box, Chip, Divider, Stack, TextField } from '@mui/material'
import ClearIcon from '@mui/icons-material/Clear'
import SearchIcon from '@mui/icons-material/Search'
import { IconButton, InputAdornment } from '@mui/material'
import { useEffect, useState } from 'react'
import {
	isWaitingOnHuman,
	OPEN_STATUSES,
	type ReviewJobsSummary,
	type TaskStatus,
} from '../types.ts'

/**
 * Statuses people typically filter by, in the order the chip row should
 * render. We deliberately omit `disconnected` from the chip row since it's
 * rare and clutters the bar — the URL still accepts it if linked from
 * elsewhere.
 */
const FILTERABLE_STATUSES: ReadonlyArray<TaskStatus> = [
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
	'done',
	'failed',
]

/** Cross-cutting quick filters that aren't expressible as a status whitelist. */
export type WaitingFilter = 'human'

export interface TasksFilterValue {
	q: string
	status: TaskStatus[] | null
	waiting: WaitingFilter | null
}

interface Props extends TasksFilterValue {
	/** How many tasks are currently open — shown on the "Open" quick-filter chip. */
	openCount: number
	/** How many tasks are waiting on a human — shown on the "Waiting on human" chip. */
	waitingCount: number
	onChange: (next: TasksFilterValue) => void
}

/**
 * Search input + status chip row for the all-tasks page. Filters live in URL
 * query params (see `tasksRoute.validateSearch`) so they survive reload and
 * can be linked.
 *
 * The text input is debounced to 200ms — typing should feel responsive but
 * we don't want to spam URL pushes on every keystroke (each one nukes the
 * tanstack-router cache for this route).
 */
export function TasksFilterBar({ q, status, waiting, openCount, waitingCount, onChange }: Props) {
	const [draft, setDraft] = useState(q)

	// Sync if the URL param changed externally (e.g. browser back).
	useEffect(() => {
		setDraft(q)
	}, [q])

	useEffect(() => {
		if (draft === q) return
		const handle = window.setTimeout(() => onChange({ q: draft, status, waiting }), 200)
		return () => window.clearTimeout(handle)
		// `onChange`, `status` and `waiting` are intentionally excluded — flushing the
		// debounced query is what this effect is for, not re-firing on filter clicks.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft])

	const toggleStatus = (s: TaskStatus): void => {
		const current = status ?? []
		const next = current.includes(s) ? current.filter((x) => x !== s) : [...current, s]
		onChange({ q, status: next.length === 0 ? null : next, waiting })
	}

	const clearAll = (): void => {
		setDraft('')
		onChange({ q: '', status: null, waiting: null })
	}

	// The quick "Open" filter is active only when the status selection is
	// exactly the open set — toggling it on selects them all, off clears the
	// status filter entirely (the text query and `waiting` are left untouched).
	const openOnly = sameStatusSet(status, OPEN_STATUSES)
	const toggleOpenOnly = (): void => {
		onChange({ q, status: openOnly ? null : [...OPEN_STATUSES], waiting })
	}

	// "Waiting on human" is a cross-cutting predicate (not a status), so it
	// lives in its own param and composes with the others via AND.
	const toggleWaiting = (): void => {
		onChange({ q, status, waiting: waiting === 'human' ? null : 'human' })
	}

	const hasFilter = q.length > 0 || (status !== null && status.length > 0) || waiting !== null

	return (
		<Stack spacing={1.5}>
			<TextField
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				placeholder="Search by title, description, or repo…"
				size="small"
				fullWidth
				slotProps={{
					input: {
						startAdornment: (
							<InputAdornment position="start">
								<SearchIcon fontSize="small" />
							</InputAdornment>
						),
						endAdornment: hasFilter ? (
							<InputAdornment position="end">
								<IconButton
									size="small"
									onClick={clearAll}
									aria-label="clear filters"
								>
									<ClearIcon fontSize="small" />
								</IconButton>
							</InputAdornment>
						) : null,
					},
				}}
			/>
			<Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
				<Chip
					label={`Open · ${openCount}`}
					size="small"
					variant={openOnly ? 'filled' : 'outlined'}
					color={openOnly ? 'primary' : 'default'}
					onClick={toggleOpenOnly}
					aria-pressed={openOnly}
				/>
				<Chip
					label={`Waiting on human · ${waitingCount}`}
					size="small"
					variant={waiting === 'human' ? 'filled' : 'outlined'}
					color={waiting === 'human' ? 'primary' : 'default'}
					onClick={toggleWaiting}
					aria-pressed={waiting === 'human'}
				/>
				<Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
				{FILTERABLE_STATUSES.map((s) => {
					const active = status !== null && status.includes(s)
					return (
						<Chip
							key={s}
							label={s}
							size="small"
							variant={active ? 'filled' : 'outlined'}
							color={active ? 'primary' : 'default'}
							onClick={() => toggleStatus(s)}
							aria-pressed={active}
						/>
					)
				})}
			</Box>
		</Stack>
	)
}

/** True when `selected` contains exactly the statuses in `target` (order-insensitive). */
export function sameStatusSet(
	selected: TaskStatus[] | null,
	target: ReadonlyArray<TaskStatus>,
): boolean {
	if (selected === null || selected.length !== target.length) return false
	const set = new Set(selected)
	return target.every((s) => set.has(s))
}

/**
 * Apply the URL-driven filter to a task array. Centralized so the
 * `(N filtered)` counter and the actual filtered list never disagree.
 */
export function filterTasks<
	T extends {
		title: string
		description: string
		repo: string | null
		status: TaskStatus
		reviewJobs: ReviewJobsSummary | null
	},
>(tasks: T[], q: string, status: TaskStatus[] | null, waiting: WaitingFilter | null): T[] {
	const needle = q.trim().toLowerCase()
	return tasks.filter((t) => {
		if (status !== null && !status.includes(t.status)) return false
		if (waiting === 'human' && !isWaitingOnHuman(t)) return false
		if (needle.length === 0) return true
		const haystack = `${t.title}\n${t.description}\n${t.repo ?? ''}`.toLowerCase()
		return haystack.includes(needle)
	})
}
