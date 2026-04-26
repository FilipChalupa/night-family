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

export type RegistryEvent =
	| { type: 'snapshot'; members: MemberSnapshot[] }
	| { type: 'member.connected'; member: MemberSnapshot }
	| { type: 'member.disconnected'; sessionId: string; memberId: string }
	| { type: 'member.updated'; member: MemberSnapshot }
