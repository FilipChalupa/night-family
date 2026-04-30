import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { EventEmitter } from 'node:events'
import type { TaskKind, TaskStatus } from '@night/shared'
import type { Db } from '../db/index.ts'
import { tasks } from '../db/schema.ts'

export interface TaskRecord {
	id: string
	repo: string | null
	kind: TaskKind
	title: string
	description: string
	status: TaskStatus
	estimateSize: 'S' | 'M' | 'L' | 'XL' | null
	estimateBlockers: string[] | null
	prUrl: string | null
	assignedSessionId: string | null
	assignedMemberId: string | null
	assignedMemberName: string | null
	failureReason: string | null
	retryCount: number
	createdAt: string
	updatedAt: string
	metadata: Record<string, unknown> | null
}

export interface CreateTaskInput {
	kind: TaskKind
	title: string
	description: string
	repo?: string | null
	metadata?: Record<string, unknown>
	/**
	 * If true, task is created in `queued`. If false (default), goes to `new`
	 * so an estimate dispatch happens first.
	 */
	skipEstimate?: boolean
}

export interface PatchTaskInput {
	title?: string
	description?: string
	estimateSize?: 'S' | 'M' | 'L' | 'XL' | null
	estimateBlockers?: string[] | null
}

function rowToRecord(row: typeof tasks.$inferSelect): TaskRecord {
	return {
		id: row.id,
		repo: row.repo,
		kind: row.kind as TaskKind,
		title: row.title,
		description: row.description,
		status: row.status as TaskStatus,
		estimateSize: (row.estimateSize as TaskRecord['estimateSize']) ?? null,
		estimateBlockers: row.estimateBlockers
			? (JSON.parse(row.estimateBlockers) as string[])
			: null,
		prUrl: row.prUrl,
		assignedSessionId: row.assignedSessionId,
		assignedMemberId: row.assignedMemberId,
		assignedMemberName: row.assignedMemberName,
		failureReason: row.failureReason,
		retryCount: row.retryCount,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
	}
}

export type TaskEvent =
	| { type: 'task.created'; task: TaskRecord }
	| { type: 'task.updated'; task: TaskRecord }
	| { type: 'task.deleted'; taskId: string }

export class TaskStore {
	private readonly emitter = new EventEmitter()

	constructor(private readonly db: Db) {}

	create(input: CreateTaskInput): TaskRecord {
		const id = randomUUID()
		const initialStatus: TaskStatus = input.skipEstimate ? 'queued' : 'new'
		const now = new Date()
		this.db
			.insert(tasks)
			.values({
				id,
				repo: input.repo ?? null,
				kind: input.kind,
				title: input.title,
				description: input.description,
				status: initialStatus,
				createdAt: now,
				updatedAt: now,
				metadata: input.metadata ? JSON.stringify(input.metadata) : null,
			})
			.run()
		const record = this.get(id)!
		this.emit({ type: 'task.created', task: record })
		return record
	}

	get(id: string): TaskRecord | null {
		const rows = this.db.select().from(tasks).where(eq(tasks.id, id)).all()
		return rows[0] ? rowToRecord(rows[0]) : null
	}

	list(filter?: { status?: TaskStatus[]; repo?: string }): TaskRecord[] {
		const conditions = []
		if (filter?.status && filter.status.length > 0) {
			conditions.push(inArray(tasks.status, filter.status))
		}
		if (filter?.repo) {
			conditions.push(eq(tasks.repo, filter.repo))
		}
		const where = conditions.length > 0 ? and(...conditions) : undefined
		const rows = this.db.select().from(tasks).where(where).orderBy(desc(tasks.createdAt)).all()
		return rows.map(rowToRecord)
	}

	patch(id: string, input: PatchTaskInput): TaskRecord | null {
		const existing = this.get(id)
		if (!existing) return null
		const update: Partial<typeof tasks.$inferInsert> = {
			updatedAt: new Date(),
		}
		if (input.title !== undefined) update.title = input.title
		if (input.description !== undefined) update.description = input.description
		if (input.estimateSize !== undefined) update.estimateSize = input.estimateSize
		if (input.estimateBlockers !== undefined) {
			update.estimateBlockers = input.estimateBlockers
				? JSON.stringify(input.estimateBlockers)
				: null
		}
		this.db.update(tasks).set(update).where(eq(tasks.id, id)).run()
		const record = this.get(id)!
		this.emit({ type: 'task.updated', task: record })
		return record
	}

	delete(id: string): boolean {
		const existing = this.get(id)
		if (!existing) return false
		this.db.delete(tasks).where(eq(tasks.id, id)).run()
		this.emit({ type: 'task.deleted', taskId: id })
		return true
	}

	/**
	 * Atomically claim the oldest task whose kind is in `acceptableKinds`
	 * and status is `queued`. Returns the assigned record, or null if none.
	 *
	 * SQLite is single-writer; the WHERE-status check makes this race-free
	 * even if concurrent dispatchers run.
	 */
	claimNextFor(
		acceptableKinds: TaskKind[],
		assignment: { sessionId: string; memberId: string; memberName: string },
	): TaskRecord | null {
		if (acceptableKinds.length === 0) return null

		// Find candidate — skip tasks whose retry delay hasn't elapsed yet.
		const now = new Date()
		const candidates = this.db
			.select({ id: tasks.id })
			.from(tasks)
			.where(
				and(
					eq(tasks.status, 'queued'),
					inArray(tasks.kind, acceptableKinds),
					or(isNull(tasks.nextRetryAt), lte(tasks.nextRetryAt, now)),
				),
			)
			.orderBy(tasks.createdAt)
			.limit(1)
			.all()
		const candidate = candidates[0]
		if (!candidate) return null

		// Atomic transition.
		const result = this.db
			.update(tasks)
			.set({
				status: 'assigned',
				assignedSessionId: assignment.sessionId,
				assignedMemberId: assignment.memberId,
				assignedMemberName: assignment.memberName,
				updatedAt: new Date(),
			})
			.where(and(eq(tasks.id, candidate.id), eq(tasks.status, 'queued')))
			.run()

		if (result.changes === 0) {
			// Lost the race; caller can try again.
			return null
		}

		const record = this.get(candidate.id)!
		this.emit({ type: 'task.updated', task: record })
		return record
	}

	/**
	 * Atomically claim a `new` task for an estimate dispatch.
	 */
	claimNextForEstimate(assignment: {
		sessionId: string
		memberId: string
		memberName: string
	}): TaskRecord | null {
		const candidates = this.db
			.select({ id: tasks.id })
			.from(tasks)
			.where(eq(tasks.status, 'new'))
			.orderBy(tasks.createdAt)
			.limit(1)
			.all()
		const candidate = candidates[0]
		if (!candidate) return null

		const result = this.db
			.update(tasks)
			.set({
				status: 'estimating',
				assignedSessionId: assignment.sessionId,
				assignedMemberId: assignment.memberId,
				assignedMemberName: assignment.memberName,
				updatedAt: new Date(),
			})
			.where(and(eq(tasks.id, candidate.id), eq(tasks.status, 'new')))
			.run()
		if (result.changes === 0) return null

		const record = this.get(candidate.id)!
		this.emit({ type: 'task.updated', task: record })
		return record
	}

	transition(
		id: string,
		from: TaskStatus[],
		to: TaskStatus,
		extras: Partial<typeof tasks.$inferInsert> = {},
	): TaskRecord | null {
		const result = this.db
			.update(tasks)
			.set({
				status: to,
				updatedAt: new Date(),
				...extras,
			})
			.where(and(eq(tasks.id, id), inArray(tasks.status, from)))
			.run()
		if (result.changes === 0) return null
		const record = this.get(id)!
		this.emit({ type: 'task.updated', task: record })
		return record
	}

	clearAssignment(id: string): TaskRecord | null {
		const existing = this.get(id)
		if (!existing) return null
		this.db
			.update(tasks)
			.set({
				assignedSessionId: null,
				assignedMemberId: null,
				assignedMemberName: null,
				updatedAt: new Date(),
			})
			.where(eq(tasks.id, id))
			.run()
		const record = this.get(id)!
		this.emit({ type: 'task.updated', task: record })
		return record
	}

	/**
	 * Re-link an in-flight task's assignment to a new session for the same
	 * member. Used when a Member reconnects under a fresh sessionId while
	 * still working on the task it was assigned. Status is preserved.
	 */
	reassignSession(
		id: string,
		assignment: { sessionId: string; memberId: string; memberName: string },
	): TaskRecord | null {
		const existing = this.get(id)
		if (!existing) return null
		this.db
			.update(tasks)
			.set({
				assignedSessionId: assignment.sessionId,
				assignedMemberId: assignment.memberId,
				assignedMemberName: assignment.memberName,
				updatedAt: new Date(),
			})
			.where(eq(tasks.id, id))
			.run()
		const record = this.get(id)!
		this.emit({ type: 'task.updated', task: record })
		return record
	}

	storeEstimateResult(
		id: string,
		size: 'S' | 'M' | 'L' | 'XL',
		blockers: string[],
	): TaskRecord | null {
		this.db
			.update(tasks)
			.set({
				estimateSize: size,
				estimateBlockers: JSON.stringify(blockers),
				updatedAt: new Date(),
			})
			.where(eq(tasks.id, id))
			.run()
		const record = this.get(id)
		if (record) this.emit({ type: 'task.updated', task: record })
		return record
	}

	incrementRetry(id: string): TaskRecord | null {
		this.db
			.update(tasks)
			.set({
				retryCount: sql`${tasks.retryCount} + 1`,
				updatedAt: new Date(),
			})
			.where(eq(tasks.id, id))
			.run()
		const record = this.get(id)
		if (record) this.emit({ type: 'task.updated', task: record })
		return record
	}

	clearRetryAt(id: string): void {
		this.db
			.update(tasks)
			.set({ nextRetryAt: null, updatedAt: new Date() })
			.where(eq(tasks.id, id))
			.run()
		const record = this.get(id)
		if (record) this.emit({ type: 'task.updated', task: record })
	}

	on(listener: (event: TaskEvent) => void): () => void {
		this.emitter.on('event', listener)
		return () => this.emitter.off('event', listener)
	}

	private emit(event: TaskEvent): void {
		this.emitter.emit('event', event)
	}
}
