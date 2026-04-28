/**
 * Stats API — aggregated dashboard charts. Read-only.
 *
 * Cheap to compute even on large task tables thanks to the indexes drizzle
 * generates on (status), (repo, status), (created_at). All aggregates are
 * scoped to the last `days` days from "now".
 */

import type Database from 'better-sqlite3'
import type { Hono } from 'hono'
import type { AdminGuard } from '../auth/guard.ts'

export interface StatsApiDeps {
	sqlite: Database.Database
	guard: AdminGuard
}

interface DailyRow {
	date: string
	created: number
	completed: number
}

interface StatusRow {
	status: string
	count: number
}

interface MemberRow {
	name: string
	completed: number
}

const DEFAULT_DAYS = 30
const MAX_DAYS = 365

export function mountStatsApi(app: Hono, deps: StatsApiDeps): void {
	app.get('/api/stats/tasks', (c) => {
		const guardResult = deps.guard.requireAuthenticated(c)
		if (guardResult) return guardResult

		const daysParam = Number.parseInt(c.req.query('days') ?? '', 10)
		const days =
			Number.isFinite(daysParam) && daysParam > 0
				? Math.min(daysParam, MAX_DAYS)
				: DEFAULT_DAYS

		const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000

		// Daily created counts.
		const createdByDay = deps.sqlite
			.prepare(
				`SELECT date(created_at / 1000, 'unixepoch') AS date, COUNT(*) AS count
				 FROM tasks
				 WHERE created_at >= ?
				 GROUP BY date
				 ORDER BY date`,
			)
			.all(cutoffMs) as Array<{ date: string; count: number }>

		// Daily completed counts. Use updated_at as the completion timestamp for
		// status='done' rows; this is when the PR webhook flipped the task.
		const completedByDay = deps.sqlite
			.prepare(
				`SELECT date(updated_at / 1000, 'unixepoch') AS date, COUNT(*) AS count
				 FROM tasks
				 WHERE status = 'done' AND updated_at >= ?
				 GROUP BY date
				 ORDER BY date`,
			)
			.all(cutoffMs) as Array<{ date: string; count: number }>

		// Build a continuous date series so the chart shows zero-days too.
		const daily = buildDailySeries(days, createdByDay, completedByDay)

		// Current status snapshot (no time filter — current state).
		const statusBreakdown = deps.sqlite
			.prepare(
				`SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY count DESC`,
			)
			.all() as StatusRow[]

		// Per-member throughput: completed tasks within the window.
		const byMember = deps.sqlite
			.prepare(
				`SELECT assigned_member_name AS name, COUNT(*) AS completed
				 FROM tasks
				 WHERE status = 'done'
				   AND assigned_member_name IS NOT NULL
				   AND updated_at >= ?
				 GROUP BY assigned_member_name
				 ORDER BY completed DESC
				 LIMIT 20`,
			)
			.all(cutoffMs) as MemberRow[]

		return c.json({
			windowDays: days,
			daily,
			statusBreakdown,
			byMember,
		})
	})
}

function buildDailySeries(
	days: number,
	created: Array<{ date: string; count: number }>,
	completed: Array<{ date: string; count: number }>,
): DailyRow[] {
	const createdMap = new Map(created.map((r) => [r.date, r.count]))
	const completedMap = new Map(completed.map((r) => [r.date, r.count]))

	const out: DailyRow[] = []
	const today = new Date()
	today.setUTCHours(0, 0, 0, 0)
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(today)
		d.setUTCDate(today.getUTCDate() - i)
		const date = d.toISOString().slice(0, 10)
		out.push({
			date,
			created: createdMap.get(date) ?? 0,
			completed: completedMap.get(date) ?? 0,
		})
	}
	return out
}
