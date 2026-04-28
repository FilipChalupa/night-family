/**
 * WebSocket protocol between Household and Member.
 * Wire format: line-delimited JSON. Versioned via `protocol_version` in handshake.
 */

export const PROTOCOL_VERSION = 1

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
	protocol_version: number
	member_id: string
	member_name: string
	skills: Skill[]
	provider: Provider
	model: string
	worker_profile: WorkerProfile
	resumes?: ResumeRef[]
}

export interface MsgMemberReady {
	type: 'member.ready'
}

export interface MsgMemberBusy {
	type: 'member.busy'
	task_id: string
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
}

export interface MsgHandshakeReject {
	type: 'handshake.reject'
	reason: string
}

export interface MsgTaskAssigned {
	type: 'task.assigned'
	task: AssignedTask
	github_token: string
	repo_url: string
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
