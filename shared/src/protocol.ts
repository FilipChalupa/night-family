/**
 * WebSocket protocol between Household and Member.
 * Wire format: line-delimited JSON. Versioned via semver-style
 * `protocol_version` (string `"major.minor.patch"`) in handshake.
 *
 * Compatibility rules (see README and AGENTS.md):
 *   - different major  → reject the handshake
 *   - different minor  → accept, log a warning on both sides
 *   - different patch  → accept silently
 *
 * Discipline: a minor bump may ONLY add things (new optional fields, new
 * message types, new enum values the peer can ignore). Anything that
 * removes, renames, retypes, or changes the meaning of an existing
 * field/message is a major bump.
 */

export const PROTOCOL_VERSION = '2.0.0'

export interface ParsedProtocolVersion {
	major: number
	minor: number
	patch: number
}

export function parseProtocolVersion(raw: string): ParsedProtocolVersion | null {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw)
	if (!m) return null
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
	}
}

export type ProtocolCompat = 'equal' | 'patch-skew' | 'minor-skew' | 'major-mismatch'

/**
 * Compare two protocol-version strings. Returns the highest level at which
 * they differ. Invalid input on either side is treated as `major-mismatch`
 * (we don't speak the same language).
 */
export function compareProtocolVersions(a: string, b: string): ProtocolCompat {
	const pa = parseProtocolVersion(a)
	const pb = parseProtocolVersion(b)
	if (!pa || !pb) return 'major-mismatch'
	if (pa.major !== pb.major) return 'major-mismatch'
	if (pa.minor !== pb.minor) return 'minor-skew'
	if (pa.patch !== pb.patch) return 'patch-skew'
	return 'equal'
}

export type Skill = 'implement' | 'review' | 'estimate' | 'respond' | 'summarize'

export const ALL_SKILLS: readonly Skill[] = [
	'implement',
	'review',
	'estimate',
	'respond',
	'summarize',
]

export type Provider = 'anthropic' | 'gemini' | 'openai'

export type WorkerProfile = 'hard' | 'medium' | 'lazy'

export type MemberStatus = 'idle' | 'busy'

export type EventKind = 'tool_call' | 'file_edited' | 'commit' | 'usage' | 'log' | 'rebase'

export type TaskKind = 'estimate' | 'implement' | 'review' | 'respond' | 'summarize'

export type TaskStatus =
	| 'new'
	| 'estimating'
	| 'queued'
	| 'assigned'
	| 'in-progress'
	| 'in-review'
	| 'awaiting-merge'
	| 'done'
	| 'failed'
	| 'disconnected'

export interface ResumeRef {
	task_id: string
	last_seq: number
}

export interface AssignedTask {
	task_id: string
	kind: TaskKind
	title: string
	description: string
	repo?: string
	pr_url?: string
	metadata?: Record<string, unknown>
}

// ---------------- Member → Household ----------------

export interface MsgHandshake {
	type: 'handshake'
	protocol_version: string
	member_id: string
	/** GitHub login of the user whose PAT this Member runs under. */
	member_name: string
	/** Pretty display name (`name ?? login` from /user). UI-only. */
	display_name: string
	skills: Skill[]
	provider: Provider
	model: string
	worker_profile: WorkerProfile
	/**
	 * Repos this Member is willing/able to work on (`org/name`). Omit for
	 * "no constraint" — Household will dispatch any repo's tasks. Empty
	 * array means "no repos accepted" and is functionally a soft offline.
	 */
	repos?: string[]
	resumes?: ResumeRef[]
}

export interface MsgMemberReady {
	type: 'member.ready'
}

export interface MsgMemberBusy {
	type: 'member.busy'
	task_id: string
	/** Human-readable title of the task the member is working on. */
	task_title?: string | null
}

export interface MsgTaskAck {
	type: 'task.ack'
	task_id: string
}

export interface MsgTaskCompleted {
	type: 'task.completed'
	task_id: string
	result: unknown
	pr_url?: string
}

export interface MsgTaskFailed {
	type: 'task.failed'
	task_id: string
	reason: string
}

export interface MsgEvent {
	type: 'event'
	task_id: string
	seq: number
	ts: string // ISO timestamp
	kind: EventKind
	payload: unknown
}

export interface MsgHeartbeat {
	type: 'heartbeat'
	status: MemberStatus
	current_task: string | null
	/** Human-readable title of the task the member is currently working on. */
	current_task_title?: string | null
}

export interface MsgPong {
	type: 'pong'
}

export type MemberToHousehold =
	| MsgHandshake
	| MsgMemberReady
	| MsgMemberBusy
	| MsgTaskAck
	| MsgTaskCompleted
	| MsgTaskFailed
	| MsgEvent
	| MsgHeartbeat
	| MsgPong

// ---------------- Household → Member ----------------

export interface MsgHandshakeAck {
	type: 'handshake.ack'
	household_name: string
	session_id: string
	protocol_version: string
}

export interface MsgHandshakeReject {
	type: 'handshake.reject'
	reason: string
}

export interface MsgTaskAssigned {
	type: 'task.assigned'
	task: AssignedTask
}

export interface MsgEventsReplayRequest {
	type: 'events.replay_request'
	task_id: string
	from_seq: number
}

export interface MsgTaskRebaseSuggested {
	type: 'task.rebase_suggested'
	task_id: string
	behind_by: number
}

export interface MsgTaskCancel {
	type: 'task.cancel'
	task_id: string
	reason: string
}

export interface MsgPing {
	type: 'ping'
}

export type HouseholdToMember =
	| MsgHandshakeAck
	| MsgHandshakeReject
	| MsgTaskAssigned
	| MsgEventsReplayRequest
	| MsgTaskRebaseSuggested
	| MsgTaskCancel
	| MsgPing

// ---------------- Helpers ----------------

export function encode(msg: MemberToHousehold | HouseholdToMember): string {
	return JSON.stringify(msg)
}

export function decode<T = MemberToHousehold | HouseholdToMember>(raw: string): T {
	return JSON.parse(raw) as T
}

export const HEARTBEAT_INTERVAL_MS = 15_000
export const PING_INTERVAL_MS = 30_000
export const HEARTBEAT_TIMEOUT_MS = 120_000
export const TASK_ACK_TIMEOUT_MS = 30_000
