import { Box, Chip, Stack, TextField } from '@mui/material'
import ClearIcon from '@mui/icons-material/Clear'
import SearchIcon from '@mui/icons-material/Search'
import { IconButton, InputAdornment } from '@mui/material'
import { useEffect, useState } from 'react'
import type { TaskStatus } from '../types.ts'

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

/**
 * "Open" / not-yet-closed tasks: everything still moving through the
 * lifecycle, i.e. all statuses except the terminal `done` / `failed`. Exported
 * so the page can count them for the title and the quick-filter chip without
 * re-deriving the set.
 */
export const OPEN_STATUSES: ReadonlyArray<TaskStatus> = [
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
]

interface Props {
	q: string
	status: TaskStatus[] | null
	/** How many tasks are currently open — shown on the quick-filter chip. */
	openCount: number
	onChange: (next: { q: string; status: TaskStatus[] | null }) => void
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
export function TasksFilterBar({ q, status, openCount, onChange }: Props) {
	const [draft, setDraft] = useState(q)

	// Sync if the URL param changed externally (e.g. browser back).
	useEffect(() => {
		setDraft(q)
	}, [q])

	useEffect(() => {
		if (draft === q) return
		const handle = window.setTimeout(() => onChange({ q: draft, status }), 200)
		return () => window.clearTimeout(handle)
		// `onChange` and `status` are intentionally excluded — flushing the debounced
		// query is what this effect is for, not re-firing on filter chip clicks.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft])

	const toggleStatus = (s: TaskStatus): void => {
		const current = status ?? []
		const next = current.includes(s) ? current.filter((x) => x !== s) : [...current, s]
		onChange({ q, status: next.length === 0 ? null : next })
	}

	const clearAll = (): void => {
		setDraft('')
		onChange({ q: '', status: null })
	}

	// The quick "Open" filter is active only when the status selection is
	// exactly the open set — toggling it on selects them all, off clears the
	// status filter entirely (the text query is left untouched).
	const openOnly = sameStatusSet(status, OPEN_STATUSES)
	const toggleOpenOnly = (): void => {
		onChange({ q, status: openOnly ? null : [...OPEN_STATUSES] })
	}

	const hasFilter = q.length > 0 || (status !== null && status.length > 0)

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
				/>
				<Box sx={{ width: '1px', alignSelf: 'stretch', bgcolor: 'divider', mx: 0.5 }} />
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
						/>
					)
				})}
			</Box>
		</Stack>
	)
}

/** True when `selected` contains exactly the statuses in `target` (order-insensitive). */
function sameStatusSet(selected: TaskStatus[] | null, target: ReadonlyArray<TaskStatus>): boolean {
	if (selected === null || selected.length !== target.length) return false
	const set = new Set(selected)
	return target.every((s) => set.has(s))
}

/**
 * Apply the URL-driven filter to a task array. Centralized so the
 * `(N filtered)` counter and the actual filtered list never disagree.
 */
export function filterTasks<
	T extends { title: string; description: string; repo: string | null; status: TaskStatus },
>(tasks: T[], q: string, status: TaskStatus[] | null): T[] {
	const needle = q.trim().toLowerCase()
	return tasks.filter((t) => {
		if (status !== null && !status.includes(t.status)) return false
		if (needle.length === 0) return true
		const haystack = `${t.title}\n${t.description}\n${t.repo ?? ''}`.toLowerCase()
		return haystack.includes(needle)
	})
}
