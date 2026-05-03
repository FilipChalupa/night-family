import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { members, taskJobs } from '../db/schema.ts'

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

interface JobJoinRow {
	job: typeof taskJobs.$inferSelect
	memberName: string | null
}

function rowToRecord(row: JobJoinRow): TaskJobRecord {
	const j = row.job
	return {
		id: j.id,
		taskId: j.taskId,
		kind: j.kind,
		status: j.status as JobStatus,
		assignedSessionId: j.assignedSessionId,
		assignedMemberId: j.assignedMemberId,
		assignedMemberName: row.memberName,
		prAuthorLogin: j.prAuthorLogin,
		verdict: (j.verdict as ReviewVerdict) ?? null,
		result: j.result ? (JSON.parse(j.result) as unknown) : null,
		failureReason: j.failureReason,
		createdAt: j.createdAt.toISOString(),
		updatedAt: j.updatedAt.toISOString(),
	}
}

export class TaskJobStore {
	constructor(private readonly db: Db) {}

	create(
		taskId: string,
		opts: { prAuthorLogin: string | null; kind?: string } = { prAuthorLogin: null },
	): TaskJobRecord {
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

	private selectJoin() {
		return this.db
			.select({ job: taskJobs, memberName: members.memberName })
			.from(taskJobs)
			.leftJoin(members, eq(members.memberId, taskJobs.assignedMemberId))
	}

	get(id: string): TaskJobRecord | null {
		const rows = this.selectJoin().where(eq(taskJobs.id, id)).all()
		return rows[0] ? rowToRecord(rows[0]) : null
	}

	listByTask(taskId: string): TaskJobRecord[] {
		return this.selectJoin().where(eq(taskJobs.taskId, taskId)).all().map(rowToRecord)
	}

	listBySession(sessionId: string): TaskJobRecord[] {
		return this.selectJoin()
			.where(eq(taskJobs.assignedSessionId, sessionId))
			.all()
			.map(rowToRecord)
	}

	listPending(): TaskJobRecord[] {
		return this.selectJoin()
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
		assignment: { sessionId: string; memberId: string },
	): TaskJobRecord | null {
		const result = this.db
			.update(taskJobs)
			.set({
				status: 'assigned',
				assignedSessionId: assignment.sessionId,
				assignedMemberId: assignment.memberId,
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
				updatedAt: new Date(),
			})
			.where(eq(taskJobs.id, id))
			.run()
	}
}
