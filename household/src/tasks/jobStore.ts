import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { taskJobs } from '../db/schema.ts'

export type JobStatus = 'pending' | 'assigned' | 'in-progress' | 'completed' | 'failed'
export type ReviewVerdict = 'approved' | 'changes_requested' | 'commented'

export interface TaskJobRecord {
	id: string
	taskId: string
	kind: string
	status: JobStatus
	assignedSessionId: string | null
	assignedMemberId: string | null
	assignedMemberName: string | null
	prAuthorLogin: string | null
	verdict: ReviewVerdict | null
	result: unknown | null
	failureReason: string | null
	createdAt: string
	updatedAt: string
}

function rowToRecord(row: typeof taskJobs.$inferSelect): TaskJobRecord {
	return {
		id: row.id,
		taskId: row.taskId,
		kind: row.kind,
		status: row.status as JobStatus,
		assignedSessionId: row.assignedSessionId,
		assignedMemberId: row.assignedMemberId,
		assignedMemberName: row.assignedMemberName,
		prAuthorLogin: row.prAuthorLogin,
		verdict: (row.verdict as ReviewVerdict) ?? null,
		result: row.result ? (JSON.parse(row.result) as unknown) : null,
		failureReason: row.failureReason,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	}
}

export class TaskJobStore {
	constructor(private readonly db: Db) {}

	create(taskId: string, opts: { prAuthorLogin: string | null; kind?: string } = { prAuthorLogin: null }): TaskJobRecord {
		const id = randomUUID()
		const now = new Date()
		this.db
			.insert(taskJobs)
			.values({
				id,
				taskId,
				kind: opts.kind ?? 'review',
				status: 'pending',
				prAuthorLogin: opts.prAuthorLogin,
				createdAt: now,
				updatedAt: now,
			})
			.run()
		return this.get(id)!
	}

	get(id: string): TaskJobRecord | null {
		const rows = this.db.select().from(taskJobs).where(eq(taskJobs.id, id)).all()
		return rows[0] ? rowToRecord(rows[0]) : null
	}

	listByTask(taskId: string): TaskJobRecord[] {
		return this.db
			.select()
			.from(taskJobs)
			.where(eq(taskJobs.taskId, taskId))
			.all()
			.map(rowToRecord)
	}

	listBySession(sessionId: string): TaskJobRecord[] {
		return this.db
			.select()
			.from(taskJobs)
			.where(eq(taskJobs.assignedSessionId, sessionId))
			.all()
			.map(rowToRecord)
	}

	listPending(): TaskJobRecord[] {
		return this.db
			.select()
			.from(taskJobs)
			.where(eq(taskJobs.status, 'pending'))
			.orderBy(taskJobs.createdAt)
			.all()
			.map(rowToRecord)
	}

	/**
	 * Atomically claim a specific pending job. Returns null if it's been
	 * snapped up by another claimer first.
	 */
	tryClaim(
		jobId: string,
		assignment: { sessionId: string; memberId: string; memberName: string },
	): TaskJobRecord | null {
		const result = this.db
			.update(taskJobs)
			.set({
				status: 'assigned',
				assignedSessionId: assignment.sessionId,
				assignedMemberId: assignment.memberId,
				assignedMemberName: assignment.memberName,
				updatedAt: new Date(),
			})
			.where(and(eq(taskJobs.id, jobId), eq(taskJobs.status, 'pending')))
			.run()

		if (result.changes === 0) return null
		return this.get(jobId)
	}

	setInProgress(id: string): void {
		this.db
			.update(taskJobs)
			.set({ status: 'in-progress', updatedAt: new Date() })
			.where(eq(taskJobs.id, id))
			.run()
	}

	complete(id: string, verdict: ReviewVerdict | null, result: unknown): void {
		this.db
			.update(taskJobs)
			.set({
				status: 'completed',
				verdict,
				result: JSON.stringify(result),
				updatedAt: new Date(),
			})
			.where(eq(taskJobs.id, id))
			.run()
	}

	fail(id: string, reason: string): void {
		this.db
			.update(taskJobs)
			.set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
			.where(eq(taskJobs.id, id))
			.run()
	}

	clearAssignment(id: string): void {
		this.db
			.update(taskJobs)
			.set({
				status: 'pending',
				assignedSessionId: null,
				assignedMemberId: null,
				assignedMemberName: null,
				updatedAt: new Date(),
			})
			.where(eq(taskJobs.id, id))
			.run()
	}
}
