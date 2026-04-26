/**
 * Persists `event` messages from Members into the `task_events` table.
 * Each row is keyed by (task_id, seq) — duplicates from replay are silently
 * ignored via INSERT OR IGNORE so reconnection idempotently catches up.
 */

import { eq, max, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { taskEvents } from '../db/schema.ts'

export interface IncomingEvent {
	taskId: string
	seq: number
	tsMs: number
	sessionId: string | null
	memberId: string | null
	kind: string
	payload: unknown
}

export class TaskEventLog {
	constructor(private readonly db: Db) {}

	/**
	 * Insert (idempotent on (task_id, seq)). Returns true if a new row was
	 * actually written.
	 */
	insert(event: IncomingEvent): boolean {
		const result = this.db
			.insert(taskEvents)
			.values({
				taskId: event.taskId,
				seq: event.seq,
				ts: new Date(event.tsMs),
				sessionId: event.sessionId,
				memberId: event.memberId,
				kind: event.kind,
				payload: JSON.stringify(event.payload),
			})
			.onConflictDoNothing()
			.run()
		return result.changes > 0
	}

	/**
	 * Highest seq we've already persisted for this task (0 if none).
	 * Used to compute `from_seq` for events.replay_request.
	 */
	maxSeq(taskId: string): number {
		const rows = this.db
			.select({ max: max(taskEvents.seq) })
			.from(taskEvents)
			.where(eq(taskEvents.taskId, taskId))
			.all()
		return rows[0]?.max ?? 0
	}

	/**
	 * Drop raw event rows older than retentionDays. Per plan §3 — default 90.
	 */
	purgeOlderThan(retentionDays: number): number {
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
		const result = this.db
			.delete(taskEvents)
			.where(sql`${taskEvents.ts} < ${cutoff}`)
			.run()
		return result.changes
	}
}
