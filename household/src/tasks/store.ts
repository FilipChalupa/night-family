import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull, like, lte, or, sql } from 'drizzle-orm'
import { EventEmitter } from 'node:events'
import type { TaskKind, TaskStatus } from '@night/shared'
import type { Db } from '../db/index.ts'
import { members, taskJobs, tasks } from '../db/schema.ts'

/**
 * Per-task counts of review-kind jobs, grouped by the lifecycle bucket the UI
 * cares about. Lets the dashboard tell apart "agent is still reviewing" from
 * "agent is done; waiting on a human". `inProgress` collapses the wire
 * statuses `assigned` + `in-progress` because the UI doesn't distinguish them.
 */
export interface ReviewJobsSummary {
	pending: number
	inProgress: number
	completed: number
	failed: number
}

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
	previousMemberId: string | null
	prAuthorLogin: string | null
	githubIssueNumber: number | null
	githubIssueUrl: string | null
	lastNotifiedStatus: TaskStatus | null
	failureReason: string | null
	retryCount: number
	createdAt: string
	updatedAt: string
	metadata: Record<string, unknown> | null
	/** `null` when the task has no review jobs (i.e. never reached `in-review`). */
	reviewJobs: ReviewJobsSummary | null
}

export interface CreateTaskInput {
	kind: TaskKind
	title: string
	description: string
	repo?: string | null
	githubIssueNumber?: number | null
	githubIssueUrl?: string | null
	metadata?: Record<string, unknown>
}

export interface PatchTaskInput {
	title?: string
	description?: string
	estimateSize?: 'S' | 'M' | 'L' | 'XL' | null
	estimateBlockers?: string[] | null
}

interface TaskJoinRow {
	task: typeof tasks.$inferSelect
	memberName: string | null
}

function rowToRecord(row: TaskJoinRow, reviewJobs: ReviewJobsSummary | null = null): TaskRecord {
	const t = row.task
	return {
		id: t.id,
		repo: t.repo,
		kind: t.kind as TaskKind,
		title: t.title,
		description: t.description,
		status: t.status as TaskStatus,
		estimateSize: (t.estimateSize as TaskRecord['estimateSize']) ?? null,
		estimateBlockers: t.estimateBlockers ? (JSON.parse(t.estimateBlockers) as string[]) : null,
		prUrl: t.prUrl,
		assignedSessionId: t.assignedSessionId,
		assignedMemberId: t.assignedMemberId,
		assignedMemberName: row.memberName,
		previousMemberId: t.previousMemberId,
		prAuthorLogin: t.prAuthorLogin,
		githubIssueNumber: t.githubIssueNumber,
		githubIssueUrl: t.githubIssueUrl,
		lastNotifiedStatus: (t.lastNotifiedStatus as TaskStatus | null) ?? null,
		failureReason: t.failureReason,
		retryCount: t.retryCount,
		createdAt: t.createdAt.toISOString(),
		updatedAt: t.updatedAt.toISOString(),
		metadata: t.metadata ? (JSON.parse(t.metadata) as Record<string, unknown>) : null,
		reviewJobs,
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
		const now = new Date()
		this.db
			.insert(tasks)
			.values({
				id,
				repo: input.repo ?? null,
				kind: input.kind,
				title: input.title,
				description: input.description,
				status: 'queued',
				githubIssueNumber: input.githubIssueNumber ?? null,
				githubIssueUrl: input.githubIssueUrl ?? null,
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
		const rows = this.db
			.select({ task: tasks, memberName: members.memberName })
			.from(tasks)
			.leftJoin(members, eq(members.memberId, tasks.assignedMemberId))
			.where(eq(tasks.id, id))
			.all()
		if (!rows[0]) return null
		const summary = this.reviewJobsSummaryByTaskIds([id]).get(id) ?? null
		return rowToRecord(rows[0], summary)
	}

	/**
	 * Indexed lookup of the (at most one) task with this `pr_url`. Faster
	 * than scanning all tasks for the repo and JSON-decoding each one.
	 */
	findByPrUrl(prUrl: string): TaskRecord | null {
		const rows = this.db
			.select({ task: tasks, memberName: members.memberName })
			.from(tasks)
			.leftJoin(members, eq(members.memberId, tasks.assignedMemberId))
			.where(eq(tasks.prUrl, prUrl))
			.limit(1)
			.all()
		if (!rows[0]) return null
		const summary =
			this.reviewJobsSummaryByTaskIds([rows[0].task.id]).get(rows[0].task.id) ?? null
		return rowToRecord(rows[0], summary)
	}

	/**
	 * Indexed lookup of tasks for a `(repo, github_issue_number)` pair. Used
	 * by issue webhooks that need to find every task spawned from one issue
	 * (triage → implement chains share the same issue number).
	 */
	findByIssueNumber(repo: string, issueNumber: number): TaskRecord[] {
		const rows = this.db
			.select({ task: tasks, memberName: members.memberName })
			.from(tasks)
			.leftJoin(members, eq(members.memberId, tasks.assignedMemberId))
			.where(and(eq(tasks.repo, repo), eq(tasks.githubIssueNumber, issueNumber)))
			.all()
		if (rows.length === 0) return []
		const summaries = this.reviewJobsSummaryByTaskIds(rows.map((r) => r.task.id))
		return rows.map((r) => rowToRecord(r, summaries.get(r.task.id) ?? null))
	}

	/**
	 * Find the (at most one) task in `repo` whose ID starts with `prefix`.
	 * Used to match a PR back to its originating task via the
	 * `pr/night/<prefix>-...` branch convention.
	 */
	findByIdPrefix(repo: string, prefix: string): TaskRecord | null {
		const lower = prefix.toLowerCase()
		const rows = this.db
			.select({ task: tasks, memberName: members.memberName })
			.from(tasks)
			.leftJoin(members, eq(members.memberId, tasks.assignedMemberId))
			.where(and(eq(tasks.repo, repo), like(tasks.id, `${lower}%`)))
			.limit(1)
			.all()
		if (!rows[0]) return null
		const summary =
			this.reviewJobsSummaryByTaskIds([rows[0].task.id]).get(rows[0].task.id) ?? null
		return rowToRecord(rows[0], summary)
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
		const rows = this.db
			.select({ task: tasks, memberName: members.memberName })
			.from(tasks)
			.leftJoin(members, eq(members.memberId, tasks.assignedMemberId))
			.where(where)
			.orderBy(desc(tasks.createdAt))
			.all()
		const summaries = this.reviewJobsSummaryByTaskIds(rows.map((r) => r.task.id))
		return rows.map((r) => rowToRecord(r, summaries.get(r.task.id) ?? null))
	}

	/**
	 * Re-emit `task.updated` for `id` without changing any task fields. Used by
	 * the dispatcher when a child review job's status changes — the task row
	 * itself is unchanged but `reviewJobs` (computed in `get()`) needs to flow
	 * to the UI so the dashboard can switch from "agent reviewing" to
	 * "waiting for human".
	 */
	republish(id: string): void {
		const record = this.get(id)
		if (record) this.emit({ type: 'task.updated', task: record })
	}

	private reviewJobsSummaryByTaskIds(taskIds: string[]): Map<string, ReviewJobsSummary> {
		const out = new Map<string, ReviewJobsSummary>()
		if (taskIds.length === 0) return out
		const rows = this.db
			.select({
				taskId: taskJobs.taskId,
				pending: sql<number>`SUM(CASE WHEN ${taskJobs.status} = 'pending' THEN 1 ELSE 0 END)`,
				inProgress: sql<number>`SUM(CASE WHEN ${taskJobs.status} IN ('assigned','in-progress') THEN 1 ELSE 0 END)`,
				completed: sql<number>`SUM(CASE WHEN ${taskJobs.status} = 'completed' THEN 1 ELSE 0 END)`,
				failed: sql<number>`SUM(CASE WHEN ${taskJobs.status} = 'failed' THEN 1 ELSE 0 END)`,
			})
			.from(taskJobs)
			.where(and(inArray(taskJobs.taskId, taskIds), eq(taskJobs.kind, 'review')))
			.groupBy(taskJobs.taskId)
			.all()
		for (const r of rows) {
			out.set(r.taskId, {
				pending: Number(r.pending) || 0,
				inProgress: Number(r.inProgress) || 0,
				completed: Number(r.completed) || 0,
				failed: Number(r.failed) || 0,
			})
		}
		return out
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

	/**
	 * Shallow-merge `partial` into the task's metadata JSON. Used to stash
	 * derived facts (e.g. PR author login at first PR-open) without losing
	 * the existing keys (issue number, source URL, …).
	 */
	mergeMetadata(id: string, partial: Record<string, unknown>): TaskRecord | null {
		const existing = this.get(id)
		if (!existing) return null
		const merged = { ...(existing.metadata ?? {}), ...partial }
		this.db
			.update(tasks)
			.set({ metadata: JSON.stringify(merged), updatedAt: new Date() })
			.where(eq(tasks.id, id))
			.run()
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
		assignment: { sessionId: string; memberId: string },
		repoAllowlist: string[] | null = null,
	): TaskRecord | null {
		if (acceptableKinds.length === 0) return null

		// Find candidate — skip tasks whose retry delay hasn't elapsed yet.
		const now = new Date()
		const baseConds = [
			eq(tasks.status, 'queued'),
			inArray(tasks.kind, acceptableKinds),
			or(isNull(tasks.nextRetryAt), lte(tasks.nextRetryAt, now)),
		]
		if (repoAllowlist) {
			// Repo-less tasks (e.g. summarize) are always allowed; repo tasks must
			// match the allowlist. Empty allowlist still permits repo-less tasks.
			const repoCond =
				repoAllowlist.length === 0
					? isNull(tasks.repo)
					: or(isNull(tasks.repo), inArray(tasks.repo, repoAllowlist))
			if (repoCond) baseConds.push(repoCond)
		}
		const candidates = this.db
			.select({ id: tasks.id })
			.from(tasks)
			.where(and(...baseConds))
			.orderBy(tasks.createdAt)
			.limit(1)
			.all()
		const candidate = candidates[0]
		if (!candidate) return null

		// Atomic transition. Clear `previousMemberId` — the dispatcher hint
		// is only meaningful while the task sits in `queued`.
		const result = this.db
			.update(tasks)
			.set({
				status: 'assigned',
				assignedSessionId: assignment.sessionId,
				assignedMemberId: assignment.memberId,
				previousMemberId: null,
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
	 * Cheap lookup: distinct `previousMemberId` values across all currently
	 * `queued` tasks. Used by the dispatcher to bias `tryDispatchAll`'s
	 * member iteration order without hydrating full TaskRecord rows.
	 */
	preferredMemberIdsForQueued(): Set<string> {
		const rows = this.db
			.selectDistinct({ memberId: tasks.previousMemberId })
			.from(tasks)
			.where(and(eq(tasks.status, 'queued'), sql`${tasks.previousMemberId} IS NOT NULL`))
			.all()
		const out = new Set<string>()
		for (const r of rows) {
			if (r.memberId) out.add(r.memberId)
		}
		return out
	}

	/**
	 * Like {@link claimNextFor}, but only matches tasks whose
	 * `previousMemberId` equals this member — i.e. tasks the member worked on
	 * previously and that came back to `queued` (e.g. after a
	 * `changes_requested` review or a retry). Used to give the original
	 * implementer first dibs so its workspace + LLM prompt cache stay warm.
	 *
	 * Clears `previousMemberId` on claim — the hint is one-shot and only
	 * meaningful while the task is in `queued`.
	 */
	claimNextForPreferredMember(
		acceptableKinds: TaskKind[],
		assignment: { sessionId: string; memberId: string },
		repoAllowlist: string[] | null = null,
	): TaskRecord | null {
		if (acceptableKinds.length === 0) return null

		const now = new Date()
		const baseConds = [
			eq(tasks.status, 'queued'),
			inArray(tasks.kind, acceptableKinds),
			eq(tasks.previousMemberId, assignment.memberId),
			or(isNull(tasks.nextRetryAt), lte(tasks.nextRetryAt, now)),
		]
		if (repoAllowlist) {
			const repoCond =
				repoAllowlist.length === 0
					? isNull(tasks.repo)
					: or(isNull(tasks.repo), inArray(tasks.repo, repoAllowlist))
			if (repoCond) baseConds.push(repoCond)
		}
		const candidates = this.db
			.select({ id: tasks.id })
			.from(tasks)
			.where(and(...baseConds))
			.orderBy(tasks.createdAt)
			.limit(1)
			.all()
		const candidate = candidates[0]
		if (!candidate) return null

		const result = this.db
			.update(tasks)
			.set({
				status: 'assigned',
				assignedSessionId: assignment.sessionId,
				assignedMemberId: assignment.memberId,
				previousMemberId: null,
				updatedAt: new Date(),
			})
			.where(and(eq(tasks.id, candidate.id), eq(tasks.status, 'queued')))
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
				updatedAt: new Date(),
			})
			.where(eq(tasks.id, id))
			.run()
		const record = this.get(id)!
		this.emit({ type: 'task.updated', task: record })
		return record
	}

	/**
	 * Snapshot the active `assignedMemberId` into `previousMemberId` (the
	 * dispatcher hint for "give this Member first dibs next time"). Called
	 * when a task is about to leave the active-work statuses (e.g.
	 * `in-review → queued` on changes_requested, or `in-progress → queued`
	 * on auto-retry). Idempotent: only writes if the value changed.
	 */
	stampPreviousMember(id: string, memberId: string | null): TaskRecord | null {
		const existing = this.get(id)
		if (!existing) return null
		if (existing.previousMemberId === memberId) return existing
		this.db
			.update(tasks)
			.set({ previousMemberId: memberId, updatedAt: new Date() })
			.where(eq(tasks.id, id))
			.run()
		const record = this.get(id)!
		this.emit({ type: 'task.updated', task: record })
		return record
	}

	setPrAuthorLogin(id: string, login: string): TaskRecord | null {
		const existing = this.get(id)
		if (!existing) return null
		if (existing.prAuthorLogin === login) return existing
		this.db
			.update(tasks)
			.set({ prAuthorLogin: login, updatedAt: new Date() })
			.where(eq(tasks.id, id))
			.run()
		const record = this.get(id)!
		this.emit({ type: 'task.updated', task: record })
		return record
	}

	/**
	 * Record that we've fired a push notification for this task at this
	 * status. Updated by the push tracker; persisted so a Household restart
	 * doesn't double-fire on the next observation.
	 */
	setLastNotifiedStatus(id: string, status: TaskStatus): void {
		this.db.update(tasks).set({ lastNotifiedStatus: status }).where(eq(tasks.id, id)).run()
	}

	/**
	 * Re-link an in-flight task's assignment to a new session for the same
	 * member. Used when a Member reconnects under a fresh sessionId while
	 * still working on the task it was assigned. Status is preserved.
	 */
	reassignSession(
		id: string,
		assignment: { sessionId: string; memberId: string },
	): TaskRecord | null {
		const existing = this.get(id)
		if (!existing) return null
		this.db
			.update(tasks)
			.set({
				assignedSessionId: assignment.sessionId,
				assignedMemberId: assignment.memberId,
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
