/**
 * Persists `event` messages from Members into the `task_events` table.
 * Each row is keyed by (task_id, seq) — duplicates from replay are silently
 * ignored via INSERT OR IGNORE so reconnection idempotently catches up.
 */

import { EventEmitter } from 'node:events'
import { desc, eq, max, sql } from 'drizzle-orm'
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

export interface StoredEvent {
	seq: number
	ts: Date
	sessionId: string | null
	memberId: string | null
	kind: string
	payload: unknown
}

/**
 * Fired when `insert` actually persists a new row. Carries `taskId` (the
 * stored row otherwise omits it, since callers already scope by task) so the
 * UI stream can route it to the right open task-events view.
 */
export interface AppendedEvent extends StoredEvent {
	taskId: string
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		return raw
	}
}

export class TaskEventLog {
	private readonly emitter = new EventEmitter()

	constructor(private readonly db: Db) {}

	/**
	 * Insert (idempotent on (task_id, seq)). Returns true if a new row was
	 * actually written.
	 */
	insert(event: IncomingEvent): boolean {
		const ts = new Date(event.tsMs)
		const result = this.db
			.insert(taskEvents)
			.values({
				taskId: event.taskId,
				seq: event.seq,
				ts,
				sessionId: event.sessionId,
				memberId: event.memberId,
				kind: event.kind,
				payload: JSON.stringify(event.payload),
			})
			.onConflictDoNothing()
			.run()
		if (result.changes > 0) {
			// Only on a genuinely new row — replayed duplicates must not
			// re-notify the UI.
			this.emit({
				taskId: event.taskId,
				seq: event.seq,
				ts,
				sessionId: event.sessionId,
				memberId: event.memberId,
				kind: event.kind,
				payload: event.payload,
			})
		}
		return result.changes > 0
	}

	/** Subscribe to newly appended events. Returns an unsubscribe function. */
	on(listener: (event: AppendedEvent) => void): () => void {
		this.emitter.on('event', listener)
		return () => this.emitter.off('event', listener)
	}

	private emit(event: AppendedEvent): void {
		this.emitter.emit('event', event)
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
	 * Return recent events for a single task, newest first. `limit` defaults
	 * to 100 (capped at 500).
	 */
	list(taskId: string, opts: { limit?: number } = {}): StoredEvent[] {
		const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
		const rows = this.db
			.select()
			.from(taskEvents)
			.where(eq(taskEvents.taskId, taskId))
			.orderBy(desc(taskEvents.seq))
			.limit(limit)
			.all()
		return rows.map((r) => ({
			seq: r.seq,
			ts: r.ts,
			sessionId: r.sessionId,
			memberId: r.memberId,
			kind: r.kind,
			payload: safeParse(r.payload),
		}))
	}

	/**
	 * Drop raw event rows older than retentionDays — default 90.
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
