// Mirrored from household runtime. Kept narrow on purpose — UI does not
// import from server packages directly.

export interface MemberSnapshot {
	sessionId: string
	memberId: string
	memberName: string
	skills: string[]
	provider: string
	model: string
	workerProfile: string
	tokenId: string
	connectedAt: string
	status: 'idle' | 'busy'
	currentTask: string | null
	lastHeartbeat: string
}

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
	failureReason: string | null
	retryCount: number
	createdAt: string
	updatedAt: string
	metadata: Record<string, unknown> | null
}

export type UiEvent =
	| { type: 'snapshot'; members: MemberSnapshot[]; tasks: TaskRecord[] }
	| { type: 'member.connected'; member: MemberSnapshot }
	| { type: 'member.disconnected'; sessionId: string; memberId: string }
	| { type: 'member.updated'; member: MemberSnapshot }
	| { type: 'task.created'; task: TaskRecord }
	| { type: 'task.updated'; task: TaskRecord }
	| { type: 'task.deleted'; taskId: string }
