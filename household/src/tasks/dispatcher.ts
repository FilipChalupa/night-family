/**
 * Hybrid pull dispatcher (per plan §3).
 *
 * Trigger points:
 *   - Member sends `member.ready` → tryDispatchOne(member)
 *   - New task is created / returned to queue → tryDispatchAll()
 *
 * Skill match:
 *   - Status `new` (needs estimate)   → only members with `estimate` skill
 *   - Status `queued`                 → only members whose skills include the
 *                                       task's kind (`implement`, `review`, …)
 *
 * Ack timeout: if Member doesn't reply with `task.ack` within
 * TASK_ACK_TIMEOUT_MS, the task is returned to its previous queue.
 */

import type { Logger } from 'pino'
import { TASK_ACK_TIMEOUT_MS, type TaskKind, type TaskStatus } from '@night/shared'
import type { ConnectedMember, MemberRegistry, MemberSnapshot } from '../members/registry.ts'
import type { RepoBindingStore } from '../github/bindings.ts'
import type { TaskRecord, TaskStore } from './store.ts'

export interface DispatcherDeps {
	taskStore: TaskStore
	registry: MemberRegistry
	bindings: RepoBindingStore | null
	logger: Logger
}

interface Pending {
	timer: NodeJS.Timeout
	previousStatus: TaskStatus
}

export class Dispatcher {
	private readonly pendingAck = new Map<string, Pending>()

	constructor(private readonly deps: DispatcherDeps) {}

	/**
	 * Walk all idle members and try to dispatch one task each. Stops once no
	 * progress can be made.
	 */
	tryDispatchAll(): void {
		for (const member of this.deps.registry.list()) {
			if (member.status !== 'idle') continue
			this.tryDispatchOne(member)
		}
	}

	tryDispatchOne(member: MemberSnapshot): void {
		const conn = this.deps.registry.get(member.sessionId)
		if (!conn) return
		if (member.status !== 'idle') return

		const assignment = {
			sessionId: member.sessionId,
			memberId: member.memberId,
			memberName: member.memberName,
		}

		let task: TaskRecord | null = null

		if (member.skills.includes('estimate')) {
			task = this.deps.taskStore.claimNextForEstimate(assignment)
		}

		if (!task) {
			// `claimNextFor` matches against the task's kind. A member with the
			// `estimate` skill can pick up explicit kind=estimate tasks too
			// (one-off estimation requests, distinct from the new→estimating
			// phase that claimNextForEstimate already covered).
			const acceptable = member.skills as TaskKind[]
			if (acceptable.length > 0) {
				task = this.deps.taskStore.claimNextFor(acceptable, assignment)
			}
		}

		if (!task) return

		this.send(conn, task)
	}

	private send(conn: ConnectedMember, task: TaskRecord): void {
		const wireKind: TaskKind = task.status === 'estimating' ? 'estimate' : task.kind

		const githubToken =
			task.repo && this.deps.bindings ? (this.deps.bindings.getPat(task.repo) ?? '') : ''

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
			this.handleAckTimeout(task.id)
		}, TASK_ACK_TIMEOUT_MS)

		this.pendingAck.set(task.id, { timer, previousStatus: task.status })
		this.deps.logger.info(
			{ taskId: task.id, member: conn.memberName, wireKind },
			'task dispatched',
		)
	}

	private handleAckTimeout(taskId: string): void {
		const pending = this.pendingAck.get(taskId)
		if (!pending) return
		this.pendingAck.delete(taskId)

		const task = this.deps.taskStore.get(taskId)
		if (!task) return
		if (task.status !== 'estimating' && task.status !== 'assigned') return

		const returnTo: TaskStatus = pending.previousStatus
		this.deps.taskStore.transition(taskId, [task.status], returnTo)
		this.deps.taskStore.clearAssignment(taskId)
		this.deps.logger.warn({ taskId, returnTo }, 'task ack timeout, returned to queue')
		this.tryDispatchAll()
	}

	onAck(taskId: string): void {
		const pending = this.pendingAck.get(taskId)
		if (pending) {
			clearTimeout(pending.timer)
			this.pendingAck.delete(taskId)
		}
		const task = this.deps.taskStore.get(taskId)
		if (!task) return
		if (task.status === 'assigned') {
			this.deps.taskStore.transition(taskId, ['assigned'], 'in-progress')
		}
		// `estimating` stays put; result delivered via task.completed.
	}

	onCompleted(taskId: string, result: unknown, prUrl: string | null): void {
		this.clearPending(taskId)
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
			this.deps.taskStore.transition(taskId, ['in-progress', 'assigned'], target, {
				...(prUrl ? { prUrl } : {}),
			})
			this.deps.logger.info({ taskId, target, prUrl }, 'task completed')
		} else {
			this.deps.logger.warn(
				{ taskId, status: task.status },
				'task.completed for task in unexpected status',
			)
		}

		this.tryDispatchAll()
	}

	onFailed(taskId: string, reason: string): void {
		this.clearPending(taskId)
		const task = this.deps.taskStore.get(taskId)
		if (!task) return
		this.deps.taskStore.transition(taskId, [task.status], 'failed', {
			failureReason: reason,
		})
		this.deps.taskStore.clearAssignment(taskId)
		this.deps.logger.warn({ taskId, reason }, 'task failed')
		this.tryDispatchAll()
	}

	/**
	 * When a Member disconnects mid-task, return the task so a different
	 * Member can pick it up. (M3 will add the disconnect grace + resume path;
	 * for M2 we just requeue.)
	 */
	onMemberDisconnected(sessionId: string): void {
		const owned = this.deps.taskStore
			.list({ status: ['estimating', 'assigned', 'in-progress'] })
			.filter((t) => t.assignedSessionId === sessionId)
		for (const task of owned) {
			this.clearPending(task.id)
			const target: TaskStatus = task.status === 'estimating' ? 'new' : 'queued'
			this.deps.taskStore.transition(task.id, [task.status], target)
			this.deps.taskStore.clearAssignment(task.id)
			this.deps.logger.info(
				{ taskId: task.id, target },
				'requeued task after member disconnect',
			)
		}
		if (owned.length > 0) this.tryDispatchAll()
	}

	private clearPending(taskId: string): void {
		const pending = this.pendingAck.get(taskId)
		if (pending) {
			clearTimeout(pending.timer)
			this.pendingAck.delete(taskId)
		}
	}
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
