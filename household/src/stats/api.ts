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

		const failedByDay = deps.sqlite
			.prepare(
				`SELECT date(updated_at / 1000, 'unixepoch') AS date, COUNT(*) AS count
				 FROM tasks
				 WHERE status = 'failed' AND updated_at >= ?
				 GROUP BY date
				 ORDER BY date`,
			)
			.all(cutoffMs) as Array<{ date: string; count: number }>

		// Tokens per day: sum the per-task final usage (input + output). Each
		// usage event is a running cumulative total, so MAX() per task gives us
		// the final spend, then SUM across tasks bucketed by their terminal day.
		const tokensByDay = deps.sqlite
			.prepare(
				`WITH task_tokens AS (
					SELECT task_id,
					       MAX(COALESCE(json_extract(payload, '$.input'), 0) +
					           COALESCE(json_extract(payload, '$.output'), 0)) AS tokens
					FROM task_events
					WHERE kind = 'usage'
					GROUP BY task_id
				 )
				 SELECT date(t.updated_at / 1000, 'unixepoch') AS date,
				        COALESCE(SUM(tt.tokens), 0) AS count
				 FROM tasks t
				 JOIN task_tokens tt ON tt.task_id = t.id
				 WHERE t.status IN ('done', 'failed')
				   AND t.updated_at >= ?
				 GROUP BY date
				 ORDER BY date`,
			)
			.all(cutoffMs) as Array<{ date: string; count: number }>

		// Build a continuous date series so the chart shows zero-days too.
		const daily = buildDailySeries(
			days,
			createdByDay,
			completedByDay,
			failedByDay,
			tokensByDay,
		)

		// Current status snapshot (no time filter — current state).
		const statusBreakdown = deps.sqlite
			.prepare(
				`SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY count DESC`,
			)
			.all() as StatusRow[]

		// Per-member throughput: completed and failed tasks plus tokens spent.
		const memberAggregates = deps.sqlite
			.prepare(
				`WITH task_tokens AS (
					SELECT task_id,
					       MAX(COALESCE(json_extract(payload, '$.input'), 0) +
					           COALESCE(json_extract(payload, '$.output'), 0)) AS tokens
					FROM task_events
					WHERE kind = 'usage'
					GROUP BY task_id
				 )
				 SELECT t.assigned_member_name AS name,
				        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS completed,
				        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed,
				        COALESCE(SUM(tt.tokens), 0) AS tokens
				 FROM tasks t
				 LEFT JOIN task_tokens tt ON tt.task_id = t.id
				 WHERE t.status IN ('done', 'failed')
				   AND t.assigned_member_name IS NOT NULL
				   AND t.updated_at >= ?
				 GROUP BY t.assigned_member_name
				 ORDER BY (completed + failed) DESC
				 LIMIT 20`,
			)
			.all(cutoffMs) as MemberRow[]
		const byMember = memberAggregates.map((r) => ({
			name: r.name,
			completed: Number(r.completed) || 0,
			failed: Number(r.failed) || 0,
			tokens: Number(r.tokens) || 0,
		}))

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
	failed: Array<{ date: string; count: number }>,
	tokens: Array<{ date: string; count: number }>,
): DailyRow[] {
	const createdMap = new Map(created.map((r) => [r.date, r.count]))
	const completedMap = new Map(completed.map((r) => [r.date, r.count]))
	const failedMap = new Map(failed.map((r) => [r.date, r.count]))
	const tokensMap = new Map(tokens.map((r) => [r.date, r.count]))

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
			failed: failedMap.get(date) ?? 0,
			tokens: tokensMap.get(date) ?? 0,
		})
	}
	return out
}
