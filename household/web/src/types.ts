// Mirrored from household runtime. Protocol enums (`Skill`, `TaskKind`,
// `TaskStatus`, …) are imported from `@night/shared` so the web stays in
// lockstep with the wire format. Wider records (e.g. `MemberSnapshot`)
// stay defined locally — they're API-shape, not protocol-shape, and the
// web should not pull household runtime in.

import type { Schedule, Skill, TaskKind, TaskStatus } from '@night/shared'
export type { Schedule, Skill, TaskKind, TaskStatus }

/**
 * Statuses for tasks still moving through the lifecycle — everything except
 * the terminal `done` / `failed`. Single source of truth for "open": used by
 * the tasks quick filter, the open-count overview, and the
 * cancellable-while-active check in the tasks table.
 */
export const OPEN_STATUSES: ReadonlyArray<TaskStatus> = [
	'queued',
	'assigned',
	'in-progress',
	'in-review',
	'awaiting-merge',
]

export interface MemberScheduleStatus {
	inNightWindow: boolean
	activeWindow: string | null
	nextTransitionAt: string
}

export interface MemberSnapshot {
	sessionId: string
	memberId: string
	memberName: string
	displayName: string
	/**
	 * Effective skills the Member is willing to take *right now* — the
	 * static capability set narrowed by the schedule and (if active) the
	 * override.
	 */
	skills: Skill[]
	/** Static capability set the Member runs with (from its `SKILLS` env). */
	fullSkills: Skill[]
	schedule: Schedule | null
	scheduleStatus: MemberScheduleStatus | null
	override: { skills: Skill[]; expiresAt: string } | null
	repos: string[] | null
	provider: string
	model: string
	workerProfile: string
	protocolVersion: string
	tokenId: string
	connectedAt: string
	firstConnectedAt: string
	status: 'idle' | 'busy' | 'offline'
	currentTask: string | null
	lastHeartbeat: string
	/**
	 * Client-derived: how many concurrent online sessions share this
	 * `memberId`. Normally `1` (or `0` for an offline member). `>1` means the
	 * same member is connected more than once at the same time — surfaced as a
	 * warning in the UI rather than silently collapsed into one row. Absent on
	 * the wire; populated only after the stream dedupes sessions by member.
	 */
	onlineSessionCount?: number
	/**
	 * Last accessible-repos refresh that failed on the live session, or
	 * `null` if the last refresh succeeded (or none has happened yet).
	 * Offline members always report `null` — refresh errors are live-session
	 * state, not persisted across reconnect.
	 */
	lastReposError: { reason: string; error: string; at: string } | null
}

export interface ReviewJobsSummary {
	pending: number
	inProgress: number
	completed: number
	failed: number
}

/**
 * Decide what `in-review` is actually waiting on. Used to add a sub-label to
 * the bare status chip — by itself the chip is ambiguous (the agent might
 * still be reviewing, or it might be done and a human's turn). Returns:
 *   - `agent`   — at least one review job is queued or running
 *   - `human`   — every review job finished; the ball is on the human side
 *                 (approve, push fixups, merge)
 *   - `unknown` — no review jobs found yet (e.g. dispatcher hasn't run)
 */
export function reviewWaitState(jobs: ReviewJobsSummary | null): 'agent' | 'human' | 'unknown' {
	if (!jobs) return 'unknown'
	if (jobs.pending > 0 || jobs.inProgress > 0) return 'agent'
	if (jobs.completed > 0 || jobs.failed > 0) return 'human'
	return 'unknown'
}

/**
 * True when the ball is in a human's court rather than an agent's: the task is
 * `awaiting-merge` (a human must merge), or it's `in-review` and every review
 * job has finished (a human must approve / push fixups / merge). Drives the
 * "Waiting on human" quick filter. A bare `in-review` with no review jobs yet
 * (`reviewWaitState === 'unknown'`) counts as agent-side and is excluded.
 */
export function isWaitingOnHuman(task: {
	status: TaskStatus
	reviewJobs: ReviewJobsSummary | null
}): boolean {
	if (task.status === 'awaiting-merge') return true
	if (task.status === 'in-review') return reviewWaitState(task.reviewJobs) === 'human'
	return false
}

export interface TaskRecord {
	id: string
	repo: string | null
	kind: TaskKind
	title: string
	description: string
	status: TaskStatus
	planSize: 'S' | 'M' | 'L' | 'XL' | null
	planBlockers: string[] | null
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
	reviewJobs: ReviewJobsSummary | null
}

export type UserRole = 'admin' | 'readonly'

export interface CurrentUser {
	authenticated: boolean
	oauth_configured: boolean
	require_ui_login: boolean
	username?: string
	role?: UserRole
	csrfToken?: string
}

export interface UserRecord {
	username: string
	role: UserRole
	added_at: string
	added_by: string
}

/** A single entry in a task's event log (as served by `/api/tasks/:id/events`). */
export interface TaskLogEvent {
	seq: number
	ts: string
	kind: string
	memberId: string | null
	payload: unknown
}

export type UiEvent =
	| {
			type: 'snapshot'
			protocolVersion: string
			members: MemberSnapshot[]
			tasks: TaskRecord[]
	  }
	| { type: 'member.connected'; member: MemberSnapshot }
	| { type: 'member.disconnected'; sessionId: string; memberId: string }
	| { type: 'member.updated'; member: MemberSnapshot }
	| { type: 'task.created'; task: TaskRecord }
	| { type: 'task.updated'; task: TaskRecord }
	| { type: 'task.deleted'; taskId: string }
	| { type: 'task.event'; taskId: string; event: TaskLogEvent }
