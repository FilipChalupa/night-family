/**
 * Hybrid pull dispatcher.
 *
 * Trigger points:
 *   - Member sends `member.ready`         → tryDispatchOne(member)
 *   - New task created / returned to queue → tryDispatchAll()
 *   - Task transitions to `in-review`      → dispatchReviewJobsFor(task)
 *
 * Skill match:
 *   - Status `queued`     → members whose effective skills ⊇ task.kind
 *   - Pending review job  → members with effective `review` skill
 *
 * "Effective skills" come from the registry, which combines the
 * Member's static capability set with the per-session schedule and any
 * active override (see `schedule/eval.ts`). The dispatcher reads the
 * effective set at every match attempt, so schedule transitions and
 * override changes propagate without the dispatcher caring how.
 *
 * Ack timeout: 30 s; unack-ed task/job returned to `queued`.
 *
 * Auto-retry (implement tasks): up to 3 attempts with exp. backoff
 * (1 min / 5 min / 15 min). After 3 failures → `failed`.
 */

import type { Logger } from 'pino'
import {
	TASK_ACK_TIMEOUT_MS,
	acceptableTaskKinds,
	type PreviewPort,
	type TaskKind,
	type TaskStatus,
} from '@night/shared'
import type { ConnectedMember, MemberRegistry, MemberSnapshot } from '../members/registry.ts'
import type { NotificationSender } from '../notifications/sender.ts'
import type { McpClaimContext, TaskRecord, TaskStore } from './store.ts'
import type { TaskJobRecord, TaskJobStore, ReviewVerdict } from './jobStore.ts'

const RETRY_BACKOFFS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const
const DEFAULT_MAX_REVIEW_JOBS_PER_TASK = 2
const DEFAULT_SELF_REVIEW_FALLBACK_MS = 10 * 60_000

/**
 * Smallest interval between two `repos.refresh` pushes to the same session.
 * Keeps us from hammering a Member's PAT against GitHub's secondary rate
 * limits when a burst of dispatch attempts all rediscover the same stale
 * allowlist; long enough for one round-trip to land and update the cache.
 */
const REPOS_REFRESH_PER_SESSION_THROTTLE_MS = 30_000

/**
 * Smallest interval between two stale-allowlist scans across the whole fleet.
 * `tryDispatchAll` runs on every member.ready / task transition, so the scan
 * itself is throttled; the per-session throttle above only kicks in when the
 * scan does decide to send.
 */
const STALE_ALLOWLIST_SCAN_THROTTLE_MS = 5_000

export interface DispatcherDeps {
	taskStore: TaskStore
	jobStore: TaskJobStore
	registry: MemberRegistry
	notifSender?: NotificationSender
	logger: Logger
	/** Optional: prefer members with this provider when dispatching review jobs. */
	reviewProviderPreference?: string | null
	/**
	 * Cap on parallel review jobs created per `implement` task per dispatch
	 * wave. Defaults to {@link DEFAULT_MAX_REVIEW_JOBS_PER_TASK}.
	 */
	maxReviewJobsPerTask?: number
	/**
	 * How long (ms) a pending review job waits for a different-login reviewer
	 * before falling back to same-login self-review. Defaults to
	 * {@link DEFAULT_SELF_REVIEW_FALLBACK_MS}. Pass 0 to disable the fallback.
	 */
	selfReviewFallbackMs?: number
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
	private readonly maxReviewJobsPerTask: number
	private readonly selfReviewFallbackMs: number
	private readonly lastReposRefreshBySession = new Map<string, number>()
	private lastStaleAllowlistScan = 0

	constructor(private readonly deps: DispatcherDeps) {
		this.maxReviewJobsPerTask = deps.maxReviewJobsPerTask ?? DEFAULT_MAX_REVIEW_JOBS_PER_TASK
		this.selfReviewFallbackMs = deps.selfReviewFallbackMs ?? DEFAULT_SELF_REVIEW_FALLBACK_MS
	}

	// ─── Public dispatch entry points ────────────────────────────────────────

	tryDispatchAll(): void {
		// Bias: members who have a `queued` task already assigned to them (e.g.
		// after a `changes_requested` review or a retry returned the task to the
		// queue) get to iterate first, so they reclaim "their" task before any
		// generic idle member races in for it.
		//
		// Within the non-preferred bucket, sort ascending by *fraction of daily
		// budget consumed* (`used / maxTokensPerDay`). Sorting by absolute
		// spend would drain low-cap members first and leave only high-cap
		// members alive by 04:00, killing agent diversity through the night.
		// Members with no daily cap report `null` and are treated as 0 — they
		// have unbounded headroom, so they should soak up work before
		// capped members do. Hard caps still live on the Member side via
		// `MAX_TOKENS_PER_DAY`; this is just a pre-cap nudge.
		const idle = this.deps.registry.list().filter((m) => m.status === 'idle')
		const preferredMemberIds = this.deps.taskStore.preferredMemberIdsForQueued()
		const tokensByMember = this.deps.taskStore.tokensSpentTodayByMember()
		const fractionFor = (m: MemberSnapshot): number => {
			if (m.maxTokensPerDay === null || m.maxTokensPerDay <= 0) return 0
			const used = tokensByMember.get(m.memberId) ?? 0
			return used / m.maxTokensPerDay
		}
		const nonPreferred = idle
			.filter((m) => !preferredMemberIds.has(m.memberId))
			.sort((a, b) => fractionFor(a) - fractionFor(b))
		const ordered = [...idle.filter((m) => preferredMemberIds.has(m.memberId)), ...nonPreferred]
		for (const member of ordered) {
			this.tryDispatchOne(member)
		}
		this.maybeRequestReposRefreshForStaleAllowlists()
	}

	/**
	 * Push `repos.refresh` to a single session, ignoring the per-session
	 * throttle (callers — e.g. day↔night schedule edges — are themselves rare
	 * enough that throttling here would just suppress the rare useful trigger).
	 * Bookkeeping is still updated so a follow-up undeliverable-task scan
	 * doesn't immediately re-ping the same session.
	 */
	requestReposRefreshForSession(sessionId: string, reason: string): void {
		const conn = this.deps.registry.get(sessionId)
		if (!conn) return
		conn.send({ type: 'repos.refresh', reason })
		this.lastReposRefreshBySession.set(sessionId, Date.now())
		this.deps.logger.debug(
			{ sessionId, member: conn.memberName, reason },
			'requested repos refresh',
		)
	}

	/**
	 * Scan currently queued tasks. For any task whose `repo` is not in *any*
	 * skill-matching member's allowlist (and at least one such member exists
	 * with a non-null allowlist — i.e. their list could plausibly be stale),
	 * ask those members to refresh from GitHub.
	 *
	 * This is what makes "user adds a new collaborator with push" land without
	 * a Member restart: the next queued task for that repo can't be claimed,
	 * the scan notices the allowlist mismatch, refresh fires, Member pushes
	 * `member.repos`, and `tryDispatchOne` picks the task up.
	 *
	 * Throttled both globally (so the scan doesn't run on every member.ready)
	 * and per session (so the same Member isn't repeatedly nagged).
	 */
	private maybeRequestReposRefreshForStaleAllowlists(now: number = Date.now()): void {
		if (now - this.lastStaleAllowlistScan < STALE_ALLOWLIST_SCAN_THROTTLE_MS) return
		this.lastStaleAllowlistScan = now

		const queued = this.deps.taskStore.list({ status: ['queued'] })
		if (queued.length === 0) return

		const members = this.deps.registry.list()
		if (members.length === 0) return

		const handled = new Set<string>()
		for (const task of queued) {
			if (!task.repo) continue
			const repo = task.repo
			const skillMatched = members.filter((m) =>
				acceptableTaskKinds(m.skills).includes(task.kind),
			)
			if (skillMatched.length === 0) continue
			const anyCovers = skillMatched.some((m) => !m.repos || m.repos.includes(repo))
			if (anyCovers) continue
			for (const m of skillMatched) {
				if (!m.repos) continue // unconstrained — refresh wouldn't change anything
				if (handled.has(m.sessionId)) continue
				const last = this.lastReposRefreshBySession.get(m.sessionId) ?? 0
				if (now - last < REPOS_REFRESH_PER_SESSION_THROTTLE_MS) continue
				const conn = this.deps.registry.get(m.sessionId)
				if (!conn) continue
				conn.send({ type: 'repos.refresh', reason: 'queue_mismatch' })
				this.lastReposRefreshBySession.set(m.sessionId, now)
				handled.add(m.sessionId)
				this.deps.logger.info(
					{
						sessionId: m.sessionId,
						member: m.memberName,
						taskRepo: repo,
						taskId: task.id,
					},
					'requested repos refresh (queued task repo missing from allowlist)',
				)
			}
		}
	}

	tryDispatchOne(member: MemberSnapshot): void {
		const conn = this.deps.registry.get(member.sessionId)
		if (!conn || member.status !== 'idle') return

		const assignment = {
			sessionId: member.sessionId,
			memberId: member.memberId,
		}

		// Queued tasks matching the Member's effective skills. Prefer tasks
		// already assigned to this Member (e.g. came back to `queued` after
		// `changes_requested`) so the original implementer reuses its warm
		// workspace + LLM prompt cache; fall back to the generic queue.
		// `acceptableTaskKinds` expands skills → kinds (notably,
		// `implement` skill also accepts `rebase` kind).
		let task: TaskRecord | null = null
		const acceptable = acceptableTaskKinds(member.skills)
		if (acceptable.length > 0) {
			// Soft MCP routing: prefer leaving an MCP-needing task for a member
			// that has the server connected, but never starve it (see mcpEligible).
			const mcp: McpClaimContext = {
				memberMcp: liveMcpNames(member),
				fleetMcp: this.fleetLiveMcp(),
			}
			task = this.deps.taskStore.claimNextForPreferredMember(
				acceptable,
				assignment,
				member.repos,
				mcp,
			)
			if (!task) {
				task = this.deps.taskStore.claimNextFor(acceptable, assignment, member.repos, mcp)
			}
		}

		if (task) {
			this.sendTask(conn, task)
			return
		}

		// Pending review jobs — pick the oldest one this member is allowed to take.
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

	/** Union of live MCP server names across every currently-connected member. */
	private fleetLiveMcp(): string[] {
		const all = new Set<string>()
		for (const m of this.deps.registry.list()) {
			for (const name of liveMcpNames(m)) all.add(name)
		}
		return [...all]
	}

	/**
	 * Is this member allowed to claim the given pending review job?
	 *
	 * A self-review (reviewer login == PR author login) is only allowed when
	 *   (a) no different-login reviewer is currently connected, OR
	 *   (b) the job has been waiting longer than `selfReviewFallbackMs` and
	 *       all different-login reviewers are still busy.
	 */
	private scheduleSelfReviewWakeup(jobId: string): void {
		if (this.selfReviewFallbackMs <= 0) return
		const existing = this.selfReviewWakeups.get(jobId)
		if (existing) clearTimeout(existing)
		const timer = setTimeout(() => {
			this.selfReviewWakeups.delete(jobId)
			this.tryDispatchAll()
		}, this.selfReviewFallbackMs).unref()
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
		// `selfReviewFallbackMs <= 0` disables the fallback entirely.
		if (this.selfReviewFallbackMs <= 0) return false
		const ageMs = Date.now() - new Date(job.createdAt).getTime()
		return ageMs >= this.selfReviewFallbackMs
	}

	/**
	 * Called when an implement task transitions to `in-review`. Creates review
	 * jobs for all currently idle reviewers (up to `maxReviewJobsPerTask`),
	 * preferring members who did NOT implement the task. Remaining jobs stay
	 * `pending` and are picked up when the next member becomes idle.
	 */
	dispatchReviewJobsFor(task: TaskRecord): void {
		if (!task.prUrl) {
			this.deps.logger.warn({ taskId: task.id }, 'dispatchReviewJobsFor: no PR URL yet')
			return
		}

		const prAuthorLogin = task.prAuthorLogin ?? task.assignedMemberName ?? null
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
			toDispatch = sorted(idleDifferentLogin).slice(0, this.maxReviewJobsPerTask)
		} else if (!anyDifferentLoginConnected && idleSameLogin.length > 0) {
			toDispatch = sorted(idleSameLogin).slice(0, this.maxReviewJobsPerTask)
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

	/**
	 * A `preview` task reported the URL its dev server is live at. Stash it in
	 * the task metadata so the dashboard can surface a clickable link while the
	 * preview runs; rendered only for active tasks, so no clear is needed when
	 * the task ends.
	 */
	/**
	 * A `preview` task reported the list of ports its dev server(s) expose.
	 * Persist it on the task so the dashboard can link to each and the
	 * `/previews/:taskId(/:port)` redirect can resolve them. Each entry's `url`
	 * is the link we surface (a Household-domain redirect URL in `household`
	 * publish mode); `target` is the live server it resolves to.
	 */
	onPreviewReady(id: string, ports: PreviewPort[]): void {
		this.deps.taskStore.mergeMetadata(id, { preview_ports: ports })
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
		this.lastReposRefreshBySession.delete(sessionId)
		// Return owned tasks to queue.
		const ownedTasks = this.deps.taskStore
			.list({ status: ['assigned', 'in-progress'] })
			.filter((t) => t.assignedSessionId === sessionId)
		for (const task of ownedTasks) {
			this.clearTaskPending(task.id)
			this.deps.taskStore.transition(task.id, [task.status], 'queued')
			this.deps.taskStore.clearAssignment(task.id)
			this.deps.logger.info(
				{ taskId: task.id, target: 'queued' },
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
		this.lastReposRefreshBySession.delete(oldSessionId)
		const ownedTasks = this.deps.taskStore
			.list({ status: ['assigned', 'in-progress'] })
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
				this.deps.taskStore.transition(task.id, [task.status], 'queued')
				this.deps.taskStore.clearAssignment(task.id)
				this.deps.logger.info(
					{ taskId: task.id, target: 'queued' },
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
		const wireKind: TaskKind = task.kind

		// The wire `metadata` carries free-form data plus indexed columns the
		// Member needs (issue ref). Indexed columns live on `tasks` rows but
		// are flattened into the wire blob so the Member's existing reader
		// (which only knows `metadata`) keeps working.
		const wireMetadata: Record<string, unknown> = { ...(task.metadata ?? {}) }
		if (task.githubIssueNumber !== null) {
			wireMetadata['github_issue_number'] = task.githubIssueNumber
		}
		if (task.githubIssueUrl !== null) {
			wireMetadata['github_issue_url'] = task.githubIssueUrl
		}

		conn.send({
			type: 'task.assigned',
			task: {
				task_id: task.id,
				kind: wireKind,
				title: task.title,
				description: task.description,
				...(task.repo ? { repo: task.repo } : {}),
				...(Object.keys(wireMetadata).length > 0 ? { metadata: wireMetadata } : {}),
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
		if (task.status !== 'assigned') return

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

		if (task.status === 'in-progress' || task.status === 'assigned') {
			if (task.kind === 'triage') {
				const triage = parseTriageResult(result)
				if (triage?.outcome === 'plan') {
					this.spawnImplementFromTriage(task, triage.size, triage.mcp)
				} else {
					this.deps.logger.info(
						{ taskId, outcome: triage?.outcome ?? 'unknown' },
						'triage finished without a plan; waiting for next human reply',
					)
				}
				this.deps.notifSender
					?.fire('triage.result', {
						taskId,
						title: task.title,
						repo: task.repo,
						issueNumber: task.githubIssueNumber,
						outcome: triage?.outcome ?? 'unknown',
						size: triage?.outcome === 'plan' ? triage.size : null,
					})
					.catch(() => undefined)
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
			if (target === 'in-review' && updated && updated.prAuthorLogin === null) {
				const author = updated.assignedMemberName
				if (author) {
					const stamped = this.deps.taskStore.setPrAuthorLogin(taskId, author)
					if (stamped) updated = stamped
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

	/**
	 * Triage decided the issue is clear and posted a plan comment. Queue
	 * a follow-up `implement` task for the same issue. Idempotent — if
	 * an implement task already exists for this issue (e.g. a previous
	 * triage cycle queued one), skip.
	 */
	private spawnImplementFromTriage(
		triage: TaskRecord,
		size: 'S' | 'M' | 'L' | 'XL' | null,
		requiredMcp: string[] = [],
	): void {
		if (!triage.repo) {
			this.deps.logger.warn(
				{ taskId: triage.id },
				'triage produced a plan but task has no repo — cannot spawn implement',
			)
			return
		}
		const issueNumber = triage.githubIssueNumber
		if (issueNumber === null) {
			this.deps.logger.warn(
				{ taskId: triage.id },
				'triage produced a plan but task has no github_issue_number — cannot spawn implement',
			)
			return
		}
		const sameIssue = this.deps.taskStore.findByIssueNumber(triage.repo, issueNumber)
		const existingImplement = sameIssue.find(
			(t) =>
				t.kind === 'implement' &&
				(t.status === 'queued' ||
					t.status === 'assigned' ||
					t.status === 'in-progress' ||
					t.status === 'in-review' ||
					t.status === 'awaiting-merge'),
		)
		if (existingImplement) {
			this.deps.logger.info(
				{ triageId: triage.id, implementId: existingImplement.id },
				'implement task already in flight for this issue — not spawning a duplicate',
			)
			return
		}
		const implement = this.deps.taskStore.create({
			kind: 'implement',
			title: triage.title,
			description: triage.description,
			repo: triage.repo,
			githubIssueNumber: issueNumber,
			githubIssueUrl: triage.githubIssueUrl,
			requiredMcp,
			metadata: { spawned_from_triage: triage.id },
		})
		if (size) {
			this.deps.taskStore.storePlanResult(implement.id, size, [])
		}
		this.deps.logger.info(
			{ triageId: triage.id, implementId: implement.id, size, requiredMcp },
			'implement task queued from triage plan',
		)
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
			// Stamp the now-departing assignee as the preferred next pickup, then
			// clear active assignment. Keeps active-vs-preferred semantics clean.
			this.deps.taskStore.stampPreviousMember(taskId, task.assignedMemberId)
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

/** Live MCP server names a member currently has connected. */
function liveMcpNames(member: MemberSnapshot): string[] {
	return member.mcpServers.filter((s) => s.status === 'live').map((s) => s.name)
}

/**
 * Parse the JSON the triage agent appends at the end of its turn:
 *   {"outcome":"question"}                      — a clarifying question was posted
 *   {"outcome":"plan","size":"M"}               — a plan comment was posted; ready
 *                                                 to enqueue an implement task
 *   {"outcome":"plan","size":"M","mcp":["linear"]} — plus the MCP servers the
 *                                                 implementer is estimated to need
 */
function parseTriageResult(
	result: unknown,
):
	| { outcome: 'question' }
	| { outcome: 'plan'; size: 'S' | 'M' | 'L' | 'XL' | null; mcp: string[] }
	| null {
	if (!result || typeof result !== 'object') return null
	const r = result as Record<string, unknown>
	const outcome = r['outcome']
	if (outcome === 'question') return { outcome }
	if (outcome === 'plan') {
		const size = r['size']
		const validSize =
			size === 'S' || size === 'M' || size === 'L' || size === 'XL' ? size : null
		const rawMcp = r['mcp']
		const mcp = Array.isArray(rawMcp)
			? rawMcp.filter((x): x is string => typeof x === 'string')
			: []
		return { outcome: 'plan', size: validSize, mcp }
	}
	return null
}

function parseReviewVerdict(result: unknown): ReviewVerdict | null {
	if (!result || typeof result !== 'object') return null
	const v = (result as Record<string, unknown>)['verdict']
	if (v === 'approved' || v === 'changes_requested' || v === 'commented') return v
	return null
}
