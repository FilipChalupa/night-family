import { EventEmitter } from 'node:events'
import type { MemberStatus, Provider, Skill, WorkerProfile } from '@night/shared'

export interface ConnectedMember {
	sessionId: string
	memberId: string
	/** GitHub login of the user whose PAT this Member runs under. */
	memberName: string
	/** Pretty display name (`name ?? login` from /user). UI-only. */
	displayName: string
	skills: Skill[]
	/** `null` = unconstrained; array = explicit allowlist of `org/name` repos. */
	repos: string[] | null
	provider: Provider
	model: string
	workerProfile: WorkerProfile
	protocolVersion: string
	tokenId: string
	connectedAt: Date
	firstConnectedAt: Date
	status: MemberStatus
	currentTask: string | null
	lastHeartbeat: Date
	send: (msg: unknown) => void
	close: (code?: number, reason?: string) => void
}

export interface MemberSnapshot {
	sessionId: string
	memberId: string
	memberName: string
	displayName: string
	skills: Skill[]
	repos: string[] | null
	provider: Provider
	model: string
	workerProfile: WorkerProfile
	protocolVersion: string
	tokenId: string
	connectedAt: string
	firstConnectedAt: string
	status: MemberStatus
	currentTask: string | null
	lastHeartbeat: string
}

export type RegistryEvent =
	| { type: 'member.connected'; member: MemberSnapshot }
	| { type: 'member.disconnected'; sessionId: string; memberId: string }
	| { type: 'member.updated'; member: MemberSnapshot }

function snapshot(m: ConnectedMember): MemberSnapshot {
	return {
		sessionId: m.sessionId,
		memberId: m.memberId,
		memberName: m.memberName,
		displayName: m.displayName,
		skills: m.skills,
		repos: m.repos,
		provider: m.provider,
		model: m.model,
		workerProfile: m.workerProfile,
		protocolVersion: m.protocolVersion,
		tokenId: m.tokenId,
		connectedAt: m.connectedAt.toISOString(),
		firstConnectedAt: m.firstConnectedAt.toISOString(),
		status: m.status,
		currentTask: m.currentTask,
		lastHeartbeat: m.lastHeartbeat.toISOString(),
	}
}

export class MemberRegistry {
	private readonly bySession = new Map<string, ConnectedMember>()
	private readonly emitter = new EventEmitter()

	add(m: ConnectedMember): void {
		this.bySession.set(m.sessionId, m)
		this.emitter.emit('event', {
			type: 'member.connected',
			member: snapshot(m),
		} satisfies RegistryEvent)
	}

	remove(sessionId: string): void {
		const m = this.bySession.get(sessionId)
		if (!m) return
		this.bySession.delete(sessionId)
		this.emitter.emit('event', {
			type: 'member.disconnected',
			sessionId,
			memberId: m.memberId,
		} satisfies RegistryEvent)
	}

	updateStatus(sessionId: string, status: MemberStatus, currentTask: string | null): void {
		const m = this.bySession.get(sessionId)
		if (!m) return
		m.status = status
		m.currentTask = currentTask
		m.lastHeartbeat = new Date()
		this.emitter.emit('event', {
			type: 'member.updated',
			member: snapshot(m),
		} satisfies RegistryEvent)
	}

	touch(sessionId: string): void {
		const m = this.bySession.get(sessionId)
		if (!m) return
		m.lastHeartbeat = new Date()
	}

	get(sessionId: string): ConnectedMember | undefined {
		return this.bySession.get(sessionId)
	}

	findByMemberId(memberId: string): ConnectedMember[] {
		return [...this.bySession.values()].filter((m) => m.memberId === memberId)
	}

	list(): MemberSnapshot[] {
		return [...this.bySession.values()].map(snapshot)
	}

	on(listener: (event: RegistryEvent) => void): () => void {
		this.emitter.on('event', listener)
		return () => {
			this.emitter.off('event', listener)
		}
	}
}
