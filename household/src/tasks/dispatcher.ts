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
import type { RepoBindingStore } from '../github/bindings.ts'
import type { TaskRecord, TaskStore } from './store.ts'
import type { TaskJobRecord, TaskJobStore, ReviewVerdict } from './jobStore.ts'

const RETRY_BACKOFFS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const
const MAX_REVIEW_JOBS = 2 // per task, per dispatch wave

export interface DispatcherDeps {
	taskStore: TaskStore
	jobStore: TaskJobStore
	registry: MemberRegistry
	bindings: RepoBindingStore | null
	logger: Logger
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
			memberName: member.memberName,
		}

		// 1. Estimate tasks (highest priority — unblocks the queue).
		let task: TaskRecord | null = null
		if (member.skills.includes('estimate')) {
			task = this.deps.taskStore.claimNextForEstimate(assignment)
		}

		// 2. Regular queued tasks matching member skills.
		if (!task) {
			const acceptable = member.skills as TaskKind[]
			if (acceptable.length > 0) {
				task = this.deps.taskStore.claimNextFor(acceptable, assignment)
			}
		}

		if (task) {
			this.sendTask(conn, task)
			return
		}

		// 3. Pending review jobs.
		if (member.skills.includes('review')) {
			const job = this.deps.jobStore.claimNextPending(assignment)
			if (job) {
				const parentTask = this.deps.taskStore.get(job.taskId)
				if (parentTask) {
					this.sendReviewJob(conn, job, parentTask)
				} else {
					// Parent task gone — mark job failed and move on.
					this.deps.jobStore.fail(job.id, 'parent_task_missing')
				}
			}
		}
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

		const idleReviewers = this.deps.registry
			.list()
			.filter((m) => m.status === 'idle' && m.skills.includes('review'))

		// Prefer non-implementors; implementor is allowed as fallback per plan §4.
		const sorted = [
			...idleReviewers.filter((m) => m.memberId !== task.assignedMemberId),
			...idleReviewers.filter((m) => m.memberId === task.assignedMemberId),
		]

		const toDispatch = sorted.slice(0, MAX_REVIEW_JOBS)

		if (toDispatch.length === 0) {
			// No idle reviewers — create one pending job; picked up on next member.ready.
			this.deps.jobStore.create(task.id)
			this.deps.logger.info(
				{ taskId: task.id },
				'no idle reviewers; review job queued as pending',
			)
			return
		}

		for (const reviewer of toDispatch) {
			const conn = this.deps.registry.get(reviewer.sessionId)
			if (!conn || reviewer.status !== 'idle') continue
			const job = this.deps.jobStore.create(task.id)
			this.sendReviewJob(conn, job, task)
		}
	}

	// ─── WS event callbacks ──────────────────────────────────────────────────

	onAck(id: string): void {
		if (this.pendingJobAck.has(id)) {
			clearTimeout(this.pendingJobAck.get(id)!.timer)
			this.pendingJobAck.delete(id)
			this.deps.jobStore.setInProgress(id)
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
			this.deps.logger.info({ taskId: task.id, target }, 'requeued task after member disconnect')
		}

		// Return owned review jobs to pending.
		const ownedJobs = this.deps.jobStore.listBySession(sessionId)
		for (const job of ownedJobs) {
			if (job.status === 'assigned' || job.status === 'in-progress') {
				clearTimeout(this.pendingJobAck.get(job.id)?.timer)
				this.pendingJobAck.delete(job.id)
				this.deps.jobStore.clearAssignment(job.id)
				this.deps.logger.info({ jobId: job.id }, 'review job returned to pending after disconnect')
			}
		}

		if (ownedTasks.length > 0 || ownedJobs.length > 0) this.tryDispatchAll()
	}

	// ─── Private task helpers ─────────────────────────────────────────────────

	private sendTask(conn: ConnectedMember, task: TaskRecord): void {
		const wireKind: TaskKind = task.status === 'estimating' ? 'estimate' : task.kind
		const githubToken = this.getToken(task.repo)

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
			github_token: githubToken,
			repo_url: task.repo ? `https://github.com/${task.repo}` : '',
		})

		this.deps.registry.updateStatus(conn.sessionId, 'busy', task.id)

		const timer = setTimeout(() => {
			this.handleTaskAckTimeout(task.id)
		}, TASK_ACK_TIMEOUT_MS)
		this.pendingTaskAck.set(task.id, { timer, previousStatus: task.status })
		this.deps.logger.info({ taskId: task.id, member: conn.memberName, wireKind }, 'task dispatched')
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
			const updated = this.deps.taskStore.transition(
				taskId,
				['in-progress', 'assigned'],
				target,
				{ ...(prUrl ? { prUrl } : {}) },
			)
			this.deps.logger.info({ taskId, target, prUrl }, 'task completed')

			// Kick off parallel review jobs immediately when task enters in-review.
			if (target === 'in-review' && updated) {
				this.dispatchReviewJobsFor(updated)
			}
		} else {
			this.deps.logger.warn({ taskId, status: task.status }, 'task.completed in unexpected status')
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
		const githubToken = this.getToken(task.repo)

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
			github_token: githubToken,
			repo_url: task.repo ? `https://github.com/${task.repo}` : '',
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

		const verdict = parseReviewVerdict(result)
		this.deps.jobStore.complete(jobId, verdict, result)
		this.deps.logger.info({ jobId, verdict }, 'review job completed')
		this.tryDispatchAll()
	}

	private onJobFailed(jobId: string, reason: string): void {
		clearTimeout(this.pendingJobAck.get(jobId)?.timer)
		this.pendingJobAck.delete(jobId)
		this.deps.jobStore.fail(jobId, reason)
		this.deps.logger.warn({ jobId, reason }, 'review job failed')
		this.tryDispatchAll()
	}

	// ─── Utility ─────────────────────────────────────────────────────────────

	private getToken(repo: string | null): string {
		return repo && this.deps.bindings ? (this.deps.bindings.getPat(repo) ?? '') : ''
	}
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

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
