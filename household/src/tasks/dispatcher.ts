/**
 * Hybrid pull dispatcher (per plan §3 / §5).
 *
 * Trigger points:
 *   - Member sends `member.ready`         → tryDispatchOne(member)
 *   - New task created / returned to queue → tryDispatchAll()
 *   - Task transitions to `in-review`      → dispatchReviewJobsFor(task)
 *
 * Skill match:
 *   - Status `new` (needs estimate)   → members with `estimate` skill
 *   - Status `queued`                 → members whose skills ⊇ task.kind
 *   - Pending review job              → members with `review` skill
 *
 * Ack timeout: 30 s; unack-ed task/job returned to its previous queue.
 *
 * Auto-retry (implement tasks): up to 3 attempts with exp. backoff
 * (1 min / 5 min / 15 min). After 3 failures → `failed`.
 */

import type { Logger } from 'pino'
import { TASK_ACK_TIMEOUT_MS, type TaskKind, type TaskStatus } from '@night/shared'
import type { ConnectedMember, MemberRegistry, MemberSnapshot } from '../members/registry.ts'
import type { NotificationSender } from '../notifications/sender.ts'
import type { TaskRecord, TaskStore } from './store.ts'
import type { TaskJobRecord, TaskJobStore, ReviewVerdict } from './jobStore.ts'

const RETRY_BACKOFFS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const
const MAX_REVIEW_JOBS = 2 // per task, per dispatch wave
const SELF_REVIEW_FALLBACK_MS = 10 * 60_000 // wait this long for a different-login reviewer before falling back to self-review

export interface DispatcherDeps {
	taskStore: TaskStore
	jobStore: TaskJobStore
	registry: MemberRegistry
	notifSender?: NotificationSender
	logger: Logger
	/** Optional: prefer members with this provider when dispatching review jobs. */
	reviewProviderPreference?: string | null
}

interface PendingTask {
	timer: NodeJS.Timeout
	previousStatus: TaskStatus
}

interface PendingJob {
	timer: NodeJS.Timeout
}

export class Dispatcher {
	private readonly pendingTaskAck = new Map<string, PendingTask>()
	private readonly pendingJobAck = new Map<string, PendingJob>()
	private readonly selfReviewWakeups = new Map<string, NodeJS.Timeout>()

	constructor(private readonly deps: DispatcherDeps) {}

	// ─── Public dispatch entry points ────────────────────────────────────────

	tryDispatchAll(): void {
		for (const member of this.deps.registry.list()) {
			if (member.status !== 'idle') continue
			this.tryDispatchOne(member)
		}
	}

	tryDispatchOne(member: MemberSnapshot): void {
		const conn = this.deps.registry.get(member.sessionId)
		if (!conn || member.status !== 'idle') return

		const assignment = {
			sessionId: member.sessionId,
			memberId: member.memberId,
		}

		// 1. Estimate tasks (highest priority — unblocks the queue).
		let task: TaskRecord | null = null
		if (member.skills.includes('estimate')) {
			task = this.deps.taskStore.claimNextForEstimate(assignment, member.repos)
		}

		// 2. Regular queued tasks matching member skills.
		if (!task) {
			const acceptable = member.skills as TaskKind[]
			if (acceptable.length > 0) {
				task = this.deps.taskStore.claimNextFor(acceptable, assignment, member.repos)
			}
		}

		if (task) {
			this.sendTask(conn, task)
			return
		}

		// 3. Pending review jobs — pick the oldest one this member is allowed to take.
		if (member.skills.includes('review')) {
			const pending = this.deps.jobStore.listPending()
			for (const candidate of pending) {
				const parentTask = this.deps.taskStore.get(candidate.taskId)
				if (!parentTask) {
					this.deps.jobStore.fail(candidate.id, 'parent_task_missing')
					this.deps.taskStore.republish(candidate.taskId)
					continue
				}
				if (!this.memberCanWorkOnRepo(member, parentTask.repo)) continue
				if (!this.canMemberClaimReview(member, candidate)) continue
				const job = this.deps.jobStore.tryClaim(candidate.id, assignment)
				if (!job) continue // raced against another claimer
				this.deps.taskStore.republish(candidate.taskId)
				this.sendReviewJob(conn, job, parentTask)
				return
			}
		}
	}

	private memberCanWorkOnRepo(member: MemberSnapshot, repo: string | null): boolean {
		if (!member.repos) return true // unconstrained
		if (!repo) return true // repo-less tasks (summarize) accepted by everyone
		return member.repos.includes(repo)
	}

	/**
	 * Is this member allowed to claim the given pending review job?
	 *
	 * A self-review (reviewer login == PR author login) is only allowed when
	 *   (a) no different-login reviewer is currently connected, OR
	 *   (b) the job has been waiting longer than SELF_REVIEW_FALLBACK_MS and
	 *       all different-login reviewers are still busy.
	 */
	private scheduleSelfReviewWakeup(jobId: string): void {
		const existing = this.selfReviewWakeups.get(jobId)
		if (existing) clearTimeout(existing)
		const timer = setTimeout(() => {
			this.selfReviewWakeups.delete(jobId)
			this.tryDispatchAll()
		}, SELF_REVIEW_FALLBACK_MS).unref()
		this.selfReviewWakeups.set(jobId, timer)
	}

	private canMemberClaimReview(member: MemberSnapshot, job: TaskJobRecord): boolean {
		const author = job.prAuthorLogin
		if (!author || author !== member.memberName) return true

		const others = this.deps.registry
			.list()
			.filter((m) => m.skills.includes('review') && m.memberName !== author)

		if (others.length === 0) return true // self-review is the only option
		if (others.some((m) => m.status === 'idle')) return false // a different-login member is free, let them take it

		// All different-login reviewers are busy — fall back after the timeout.
		const ageMs = Date.now() - new Date(job.createdAt).getTime()
		return ageMs >= SELF_REVIEW_FALLBACK_MS
	}

	/**
	 * Called when an implement task transitions to `in-review`. Creates review
	 * jobs for all currently idle reviewers (up to MAX_REVIEW_JOBS), preferring
	 * members who did NOT implement the task. Remaining jobs stay `pending` and
	 * are picked up when the next member becomes idle.
	 */
	dispatchReviewJobsFor(task: TaskRecord): void {
		if (!task.prUrl) {
			this.deps.logger.warn({ taskId: task.id }, 'dispatchReviewJobsFor: no PR URL yet')
			return
		}

		const prAuthorLogin = readPrAuthorLogin(task) ?? task.assignedMemberName ?? null
		const reviewers = this.deps.registry
			.list()
			.filter((m) => m.skills.includes('review') && this.memberCanWorkOnRepo(m, task.repo))
		const idleReviewers = reviewers.filter((m) => m.status === 'idle')
		const pref = this.deps.reviewProviderPreference ?? null

		const score = (m: MemberSnapshot): number =>
			(pref && m.provider === pref ? 4 : 0) +
			(prAuthorLogin && m.memberName !== prAuthorLogin ? 2 : 0) +
			(m.memberId !== task.assignedMemberId ? 1 : 0)

		// Prefer different-login reviewers when we have a PR author login to compare.
		const idleDifferentLogin = idleReviewers.filter(
			(m) => !prAuthorLogin || m.memberName !== prAuthorLogin,
		)
		const idleSameLogin = idleReviewers.filter(
			(m) => prAuthorLogin && m.memberName === prAuthorLogin,
		)
		const anyDifferentLoginConnected = reviewers.some(
			(m) => !prAuthorLogin || m.memberName !== prAuthorLogin,
		)

		const sorted = (xs: MemberSnapshot[]): MemberSnapshot[] =>
			xs.slice().sort((a, b) => score(b) - score(a))

		// Pick reviewers to dispatch right now:
		//   - If different-login idle members exist, take from there.
		//   - Else if NO different-login member is even connected, fall back to
		//     same-login self-review immediately (the "solo member" case).
		//   - Otherwise queue pending and let the 10-min fallback decide later.
		let toDispatch: MemberSnapshot[]
		if (idleDifferentLogin.length > 0) {
			toDispatch = sorted(idleDifferentLogin).slice(0, MAX_REVIEW_JOBS)
		} else if (!anyDifferentLoginConnected && idleSameLogin.length > 0) {
			toDispatch = sorted(idleSameLogin).slice(0, MAX_REVIEW_JOBS)
		} else {
			toDispatch = []
		}

		if (toDispatch.length === 0) {
			const job = this.deps.jobStore.create(task.id, { prAuthorLogin })
			this.deps.taskStore.republish(task.id)
			this.deps.logger.info(
				{ taskId: task.id, prAuthorLogin, jobId: job.id },
				'no eligible idle reviewers; review job queued as pending',
			)
			// If only same-login reviewers are connected and they're all busy,
			// the registry won't fire another tryDispatchAll until somebody goes
			// idle. Wake up after the self-review fallback window so a same-login
			// reviewer can pick this up if a different-login one never frees up.
			if (prAuthorLogin && idleSameLogin.length === 0) {
				this.scheduleSelfReviewWakeup(job.id)
			}
			return
		}

		for (const reviewer of toDispatch) {
			const conn = this.deps.registry.get(reviewer.sessionId)
			if (!conn || reviewer.status !== 'idle') continue
			const job = this.deps.jobStore.create(task.id, { prAuthorLogin })
			const claimed = this.deps.jobStore.tryClaim(job.id, {
				sessionId: conn.sessionId,
				memberId: conn.memberId,
			})
			if (!claimed) continue
			this.sendReviewJob(conn, claimed, task)
		}
		this.deps.taskStore.republish(task.id)
	}

	// ─── WS event callbacks ──────────────────────────────────────────────────

	onAck(id: string): void {
		if (this.pendingJobAck.has(id)) {
			clearTimeout(this.pendingJobAck.get(id)!.timer)
			this.pendingJobAck.delete(id)
			this.deps.jobStore.setInProgress(id)
			this.republishParentForJob(id)
			return
		}

		const pending = this.pendingTaskAck.get(id)
		if (pending) {
			clearTimeout(pending.timer)
			this.pendingTaskAck.delete(id)
		}
		const task = this.deps.taskStore.get(id)
		if (!task) return
		if (task.status === 'assigned') {
			this.deps.taskStore.transition(id, ['assigned'], 'in-progress')
		}
	}

	onCompleted(id: string, result: unknown, prUrl: string | null): void {
		if (this.pendingJobAck.has(id) || this.deps.jobStore.get(id)) {
			this.onJobCompleted(id, result)
			return
		}
		this.onTaskCompleted(id, result, prUrl)
	}

	onFailed(id: string, reason: string): void {
		if (this.pendingJobAck.has(id) || this.deps.jobStore.get(id)) {
			this.onJobFailed(id, reason)
			return
		}
		this.onTaskFailed(id, reason)
	}

	onMemberDisconnected(sessionId: string): void {
		// Return owned tasks to queue.
		const ownedTasks = this.deps.taskStore
			.list({ status: ['estimating', 'assigned', 'in-progress'] })
			.filter((t) => t.assignedSessionId === sessionId)
		for (const task of ownedTasks) {
			this.clearTaskPending(task.id)
			const target: TaskStatus = task.status === 'estimating' ? 'new' : 'queued'
			this.deps.taskStore.transition(task.id, [task.status], target)
			this.deps.taskStore.clearAssignment(task.id)
			this.deps.logger.info(
				{ taskId: task.id, target },
				'requeued task after member disconnect',
			)
		}

		// Return owned review jobs to pending.
		const ownedJobs = this.deps.jobStore.listBySession(sessionId)
		for (const job of ownedJobs) {
			if (job.status === 'assigned' || job.status === 'in-progress') {
				clearTimeout(this.pendingJobAck.get(job.id)?.timer)
				this.pendingJobAck.delete(job.id)
				this.deps.jobStore.clearAssignment(job.id)
				this.deps.logger.info(
					{ jobId: job.id },
					'review job returned to pending after disconnect',
				)
			}
		}

		if (ownedTasks.length > 0 || ownedJobs.length > 0) {
			this.deps.notifSender?.fire('member.disconnected', { sessionId }).catch(() => undefined)
			this.tryDispatchAll()
		}
	}

	/**
	 * Called when a Member's WS is replaced by a fresh handshake from the same
	 * member_id — i.e. the Member reconnected before we noticed the previous
	 * socket was dead. Tasks the new session declared via `resumes` are
	 * re-linked to it (status preserved). Anything else owned by the old
	 * session is treated as a regular disconnect: requeued.
	 */
	onMemberSuperseded(
		oldSessionId: string,
		newAssignment: { sessionId: string; memberId: string },
		retainedTaskIds: ReadonlySet<string>,
	): void {
		const ownedTasks = this.deps.taskStore
			.list({ status: ['estimating', 'assigned', 'in-progress'] })
			.filter((t) => t.assignedSessionId === oldSessionId)
		let requeued = 0
		let retained = 0
		for (const task of ownedTasks) {
			if (retainedTaskIds.has(task.id)) {
				this.clearTaskPending(task.id)
				this.deps.taskStore.reassignSession(task.id, newAssignment)
				this.deps.logger.info(
					{ taskId: task.id, newSessionId: newAssignment.sessionId },
					'task re-linked to resumed session',
				)
				retained++
			} else {
				this.clearTaskPending(task.id)
				const target: TaskStatus = task.status === 'estimating' ? 'new' : 'queued'
				this.deps.taskStore.transition(task.id, [task.status], target)
				this.deps.taskStore.clearAssignment(task.id)
				this.deps.logger.info(
					{ taskId: task.id, target },
					'requeued task after member supersede (not in resumes)',
				)
				requeued++
			}
		}

		// Review jobs cannot resume across sockets — return them to pending.
		const ownedJobs = this.deps.jobStore.listBySession(oldSessionId)
		for (const job of ownedJobs) {
			if (job.status === 'assigned' || job.status === 'in-progress') {
				clearTimeout(this.pendingJobAck.get(job.id)?.timer)
				this.pendingJobAck.delete(job.id)
				this.deps.jobStore.clearAssignment(job.id)
				this.deps.logger.info(
					{ jobId: job.id },
					'review job returned to pending after supersede',
				)
				requeued++
			}
		}

		if (requeued > 0) this.tryDispatchAll()
		this.deps.logger.debug(
			{ oldSessionId, newSessionId: newAssignment.sessionId, retained, requeued },
			'member supersede complete',
		)
	}

	// ─── Private task helpers ─────────────────────────────────────────────────

	private sendTask(conn: ConnectedMember, task: TaskRecord): void {
		const wireKind: TaskKind = task.status === 'estimating' ? 'estimate' : task.kind

		conn.send({
			type: 'task.assigned',
			task: {
				task_id: task.id,
				kind: wireKind,
				title: task.title,
				description: task.description,
				...(task.repo ? { repo: task.repo } : {}),
				...(task.metadata ? { metadata: task.metadata } : {}),
			},
		})

		this.deps.registry.updateStatus(conn.sessionId, 'busy', task.id)

		const timer = setTimeout(() => {
			this.handleTaskAckTimeout(task.id)
		}, TASK_ACK_TIMEOUT_MS)
		this.pendingTaskAck.set(task.id, { timer, previousStatus: task.status })
		this.deps.logger.info(
			{ taskId: task.id, member: conn.memberName, wireKind },
			'task dispatched',
		)
	}

	private handleTaskAckTimeout(taskId: string): void {
		const pending = this.pendingTaskAck.get(taskId)
		if (!pending) return
		this.pendingTaskAck.delete(taskId)

		const task = this.deps.taskStore.get(taskId)
		if (!task) return
		if (task.status !== 'estimating' && task.status !== 'assigned') return

		const returnTo: TaskStatus = pending.previousStatus
		this.deps.taskStore.transition(taskId, [task.status], returnTo)
		this.deps.taskStore.clearAssignment(taskId)
		this.deps.logger.warn({ taskId, returnTo }, 'task ack timeout, returned to queue')
		this.tryDispatchAll()
	}

	private onTaskCompleted(taskId: string, result: unknown, prUrl: string | null): void {
		this.clearTaskPending(taskId)
		const task = this.deps.taskStore.get(taskId)
		if (!task) return

		if (task.status === 'estimating') {
			const parsed = parseEstimateResult(result)
			if (parsed) {
				this.deps.taskStore.storeEstimateResult(taskId, parsed.size, parsed.blockers)
			}
			this.deps.taskStore.transition(taskId, ['estimating'], 'queued')
			this.deps.taskStore.clearAssignment(taskId)
			this.deps.logger.info({ taskId, estimate: parsed }, 'estimate completed')
		} else if (task.status === 'in-progress' || task.status === 'assigned') {
			if (task.kind === 'estimate') {
				const parsed = parseEstimateResult(result)
				if (parsed) {
					this.deps.taskStore.storeEstimateResult(taskId, parsed.size, parsed.blockers)
				}
			}
			const target: TaskStatus = task.kind === 'implement' ? 'in-review' : 'done'
			let updated = this.deps.taskStore.transition(
				taskId,
				['in-progress', 'assigned'],
				target,
				{ ...(prUrl ? { prUrl } : {}) },
			)
			this.deps.logger.info({ taskId, target, prUrl }, 'task completed')

			// On the FIRST PR-open transition, snapshot the implementer's GitHub
			// login as the PR author so subsequent review picks can identify
			// self-review even after a `changes_requested` cycle reassigns the
			// task to a different member.
			if (target === 'in-review' && updated && readPrAuthorLogin(updated) === null) {
				const author = updated.assignedMemberName
				if (author) {
					const merged = this.deps.taskStore.mergeMetadata(taskId, {
						pr_author_login: author,
					})
					if (merged) updated = merged
				}
			}

			// Kick off parallel review jobs immediately when task enters in-review.
			if (target === 'in-review' && updated) {
				this.dispatchReviewJobsFor(updated)
			}

			// Fire summarize.result notification when a summarize task finishes.
			if (task.kind === 'summarize') {
				const summary = (result as Record<string, unknown>)?.['summary'] ?? ''
				this.deps.notifSender
					?.fire('summarize.result', { taskId, title: task.title, summary })
					.catch(() => undefined)
			}
		} else {
			this.deps.logger.warn(
				{ taskId, status: task.status },
				'task.completed in unexpected status',
			)
		}

		this.tryDispatchAll()
	}

	private onTaskFailed(taskId: string, reason: string): void {
		this.clearTaskPending(taskId)
		const task = this.deps.taskStore.get(taskId)
		if (!task) return

		// Auto-retry implement tasks up to 3 times with exp. backoff.
		if (task.kind === 'implement' && task.retryCount < RETRY_BACKOFFS_MS.length) {
			const backoffMs = RETRY_BACKOFFS_MS[task.retryCount]!
			this.deps.taskStore.incrementRetry(taskId)
			this.deps.taskStore.transition(taskId, [task.status], 'queued', {
				failureReason: reason,
				nextRetryAt: new Date(Date.now() + backoffMs),
			})
			this.deps.taskStore.clearAssignment(taskId)
			this.deps.logger.warn(
				{ taskId, reason, attempt: task.retryCount + 1, backoffMs },
				'implement task failed, scheduling retry',
			)
			setTimeout(() => {
				this.deps.taskStore.clearRetryAt(taskId)
				this.tryDispatchAll()
			}, backoffMs)
			return
		}

		this.deps.taskStore.transition(taskId, [task.status], 'failed', { failureReason: reason })
		this.deps.taskStore.clearAssignment(taskId)
		this.deps.logger.warn({ taskId, reason }, 'task failed')
		const eventName = reason === 'quota_exceeded' ? 'quota_exceeded' : 'task.failed'
		this.deps.notifSender
			?.fire(eventName, { taskId, reason, title: task.title })
			.catch(() => undefined)
		this.tryDispatchAll()
	}

	private clearTaskPending(taskId: string): void {
		const pending = this.pendingTaskAck.get(taskId)
		if (pending) {
			clearTimeout(pending.timer)
			this.pendingTaskAck.delete(taskId)
		}
	}

	// ─── Private job helpers ──────────────────────────────────────────────────

	private sendReviewJob(conn: ConnectedMember, job: TaskJobRecord, task: TaskRecord): void {
		conn.send({
			type: 'task.assigned',
			task: {
				task_id: job.id,
				kind: 'review',
				title: `Review: ${task.title}`,
				description: task.description,
				...(task.repo ? { repo: task.repo } : {}),
				...(task.prUrl ? { pr_url: task.prUrl } : {}),
				metadata: { parent_task_id: task.id },
			},
		})

		this.deps.registry.updateStatus(conn.sessionId, 'busy', job.id)

		const timer = setTimeout(() => {
			this.handleJobAckTimeout(job.id)
		}, TASK_ACK_TIMEOUT_MS)
		this.pendingJobAck.set(job.id, { timer })
		this.deps.logger.info(
			{ jobId: job.id, taskId: task.id, member: conn.memberName },
			'review job dispatched',
		)
	}

	private handleJobAckTimeout(jobId: string): void {
		if (!this.pendingJobAck.has(jobId)) return
		this.pendingJobAck.delete(jobId)
		this.deps.jobStore.clearAssignment(jobId)
		this.deps.logger.warn({ jobId }, 'review job ack timeout, returned to pending')
		this.tryDispatchAll()
	}

	private onJobCompleted(jobId: string, result: unknown): void {
		clearTimeout(this.pendingJobAck.get(jobId)?.timer)
		this.pendingJobAck.delete(jobId)
		this.clearSelfReviewWakeup(jobId)

		const verdict = parseReviewVerdict(result)
		this.deps.jobStore.complete(jobId, verdict, result)
		this.republishParentForJob(jobId)
		this.deps.logger.info({ jobId, verdict }, 'review job completed')
		this.tryDispatchAll()
	}

	private onJobFailed(jobId: string, reason: string): void {
		clearTimeout(this.pendingJobAck.get(jobId)?.timer)
		this.pendingJobAck.delete(jobId)
		this.clearSelfReviewWakeup(jobId)
		this.deps.jobStore.fail(jobId, reason)
		this.republishParentForJob(jobId)
		this.deps.logger.warn({ jobId, reason }, 'review job failed')
		this.tryDispatchAll()
	}

	/**
	 * Re-emit `task.updated` for the parent of `jobId` so the dashboard sees
	 * the updated `reviewJobs` summary (the task row itself didn't change).
	 * Best-effort — silently no-ops if the job was already deleted.
	 */
	private republishParentForJob(jobId: string): void {
		const job = this.deps.jobStore.get(jobId)
		if (job) this.deps.taskStore.republish(job.taskId)
	}

	private clearSelfReviewWakeup(jobId: string): void {
		const t = this.selfReviewWakeups.get(jobId)
		if (t) {
			clearTimeout(t)
			this.selfReviewWakeups.delete(jobId)
		}
	}
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function readPrAuthorLogin(task: TaskRecord): string | null {
	const meta = task.metadata
	if (!meta) return null
	const v = (meta as Record<string, unknown>)['pr_author_login']
	return typeof v === 'string' && v.length > 0 ? v : null
}

function parseEstimateResult(
	result: unknown,
): { size: 'S' | 'M' | 'L' | 'XL'; blockers: string[] } | null {
	if (!result || typeof result !== 'object') return null
	const r = result as Record<string, unknown>
	const size = r['size']
	const blockers = r['blockers']
	if (size !== 'S' && size !== 'M' && size !== 'L' && size !== 'XL') return null
	if (!Array.isArray(blockers)) return null
	return {
		size,
		blockers: blockers.filter((b): b is string => typeof b === 'string'),
	}
}

function parseReviewVerdict(result: unknown): ReviewVerdict | null {
	if (!result || typeof result !== 'object') return null
	const v = (result as Record<string, unknown>)['verdict']
	if (v === 'approved' || v === 'changes_requested' || v === 'commented') return v
	return null
}
