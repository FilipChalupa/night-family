import { EventEmitter } from 'node:events'
import type { MemberStatus, Provider, Schedule, Skill, WorkerProfile } from '@night/shared'
import {
	effectiveSkillsAt,
	isNightAt,
	nextTransition,
	type ScheduleOverride,
} from '../schedule/eval.ts'
import type { MemberStateStore } from './store.ts'

/**
 * UI-facing status of a member snapshot. `offline` is never emitted by a
 * Member over the wire (only `idle` / `busy` are valid `MemberStatus`); it's
 * synthesized server-side for persisted-but-disconnected members surfaced
 * by the dashboard.
 */
export type MemberSnapshotStatus = MemberStatus | 'offline'

export interface ConnectedMember {
	sessionId: string
	memberId: string
	/** GitHub login of the user whose PAT this Member runs under. */
	memberName: string
	/** Pretty display name (`name ?? login` from /user). UI-only. */
	displayName: string
	/**
	 * Static capability set the Member runs with (from its `SKILLS` env).
	 * Frozen at handshake; doesn't change during the session.
	 */
	skills: Skill[]
	/**
	 * Per-Member schedule that gates the `implement` skill in time. Sent on
	 * handshake; evaluated Household-side via `schedule/eval.ts`.
	 */
	schedule: Schedule
	/**
	 * Admin-driven override applied alongside the schedule when computing
	 * effective skills. `null` when no override is active or the active one
	 * has expired (cleared lazily by the registry on read).
	 */
	override: ScheduleOverride | null
	/** `null` = unconstrained; array = explicit allowlist of `org/name` repos. */
	repos: string[] | null
	provider: Provider
	model: string
	workerProfile: WorkerProfile
	protocolVersion: string
	tokenId: string
	/**
	 * Member-reported daily token cap (`MAX_TOKENS_PER_DAY` on the Member
	 * side). `null` = uncapped. Used by the dispatcher as the denominator in
	 * load-balanced ordering — sorting non-preferred members by `used / cap`
	 * preserves diversity through the night even when caps differ.
	 */
	maxTokensPerDay: number | null
	connectedAt: Date
	firstConnectedAt: Date
	status: MemberStatus
	currentTask: string | null
	lastHeartbeat: Date
	send: (msg: unknown) => void
	close: (code?: number, reason?: string) => void
}

/**
 * Derived schedule state shipped with each snapshot, so the UI can render
 * "currently in night, ends in 4h 02m" / "next night in 14h 13m" without
 * having to redo time-zone math client-side.
 */
export interface MemberScheduleStatus {
	/** True when at least one nightWindow is active for the member's tz. */
	inNightWindow: boolean
	/** Name of the active nightWindow, if any. */
	activeWindow: string | null
	/** ISO timestamp at which the next schedule edge fires. */
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
	 * override. The dispatcher uses this to gate task assignment, and the
	 * UI displays it as "currently advertising".
	 */
	skills: Skill[]
	/** Static capability set the Member runs with (from its `SKILLS` env). */
	fullSkills: Skill[]
	schedule: Schedule | null
	scheduleStatus: MemberScheduleStatus | null
	override: { skills: Skill[]; expiresAt: string } | null
	repos: string[] | null
	provider: Provider
	model: string
	workerProfile: WorkerProfile
	protocolVersion: string
	tokenId: string
	/** Mirror of {@link ConnectedMember.maxTokensPerDay}; `null` = uncapped. */
	maxTokensPerDay: number | null
	connectedAt: string
	firstConnectedAt: string
	status: MemberSnapshotStatus
	currentTask: string | null
	lastHeartbeat: string
}

export type RegistryEvent =
	| { type: 'member.connected'; member: MemberSnapshot }
	| { type: 'member.disconnected'; sessionId: string; memberId: string }
	| { type: 'member.updated'; member: MemberSnapshot }

function snapshotConnected(m: ConnectedMember, now: Date = new Date()): MemberSnapshot {
	const liveOverride =
		m.override && m.override.expiresAt.getTime() > now.getTime() ? m.override : null
	const night = isNightAt(m.schedule, now)
	return {
		sessionId: m.sessionId,
		memberId: m.memberId,
		memberName: m.memberName,
		displayName: m.displayName,
		skills: [...effectiveSkillsAt(m.skills, m.schedule, liveOverride, now)],
		fullSkills: m.skills,
		schedule: m.schedule,
		scheduleStatus: {
			inNightWindow: night.active,
			activeWindow: night.window,
			nextTransitionAt: nextTransition(m.schedule, now).toISOString(),
		},
		override: liveOverride
			? { skills: [...liveOverride.skills], expiresAt: liveOverride.expiresAt.toISOString() }
			: null,
		repos: m.repos,
		provider: m.provider,
		model: m.model,
		workerProfile: m.workerProfile,
		protocolVersion: m.protocolVersion,
		tokenId: m.tokenId,
		maxTokensPerDay: m.maxTokensPerDay,
		connectedAt: m.connectedAt.toISOString(),
		firstConnectedAt: m.firstConnectedAt.toISOString(),
		status: m.status,
		currentTask: m.currentTask,
		lastHeartbeat: m.lastHeartbeat.toISOString(),
	}
}

export interface MemberRegistryDeps {
	/**
	 * Called when a session's schedule (or override) edge fires — gives the
	 * dispatcher a chance to assign newly-eligible tasks. The registry has
	 * already re-emitted `member.updated` by the time this runs.
	 */
	onScheduleTick?: (sessionId: string) => void
	/** Test seam. Defaults to `setTimeout`. */
	setTimeoutFn?: (cb: () => void, ms: number) => NodeJS.Timeout
	clearTimeoutFn?: (t: NodeJS.Timeout) => void
}

export class MemberRegistry {
	private readonly bySession = new Map<string, ConnectedMember>()
	private readonly tickers = new Map<string, NodeJS.Timeout>()
	private readonly emitter = new EventEmitter()
	private readonly setTimeoutFn: NonNullable<MemberRegistryDeps['setTimeoutFn']>
	private readonly clearTimeoutFn: NonNullable<MemberRegistryDeps['clearTimeoutFn']>
	private onScheduleTick: MemberRegistryDeps['onScheduleTick']

	constructor(
		private readonly persistence: MemberStateStore | null = null,
		deps: MemberRegistryDeps = {},
	) {
		this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout
		this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout
		this.onScheduleTick = deps.onScheduleTick
	}

	/**
	 * Late wiring for the dispatcher kick — the registry is constructed
	 * before the dispatcher exists.
	 */
	setOnScheduleTick(cb: (sessionId: string) => void): void {
		this.onScheduleTick = cb
	}

	add(m: ConnectedMember): void {
		this.bySession.set(m.sessionId, m)
		this.persistence?.upsertOnConnect({
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
			connectedAt: m.connectedAt,
		})
		this.scheduleTicker(m)
		this.emitter.emit('event', {
			type: 'member.connected',
			member: snapshotConnected(m),
		} satisfies RegistryEvent)
	}

	remove(sessionId: string): void {
		const m = this.bySession.get(sessionId)
		if (!m) return
		this.bySession.delete(sessionId)
		this.clearTicker(sessionId)
		this.persistence?.markDisconnected(m.memberId)
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
		this.persistence?.touch(m.memberId, m.lastHeartbeat)
		this.emitter.emit('event', {
			type: 'member.updated',
			member: snapshotConnected(m),
		} satisfies RegistryEvent)
	}

	/**
	 * Replace a session's cached repos allowlist with a fresh list pushed by
	 * the Member (`member.repos`). The handshake-time list is just a snapshot,
	 * so this lets a long-lived Member pick up newly granted repos without a
	 * full reconnect. Emits `member.updated` so the UI and any listening
	 * dispatcher see the change.
	 */
	updateRepos(sessionId: string, repos: string[]): boolean {
		const m = this.bySession.get(sessionId)
		if (!m) return false
		m.repos = repos
		m.lastHeartbeat = new Date()
		this.persistence?.updateRepos(m.memberId, repos)
		this.emitter.emit('event', {
			type: 'member.updated',
			member: snapshotConnected(m),
		} satisfies RegistryEvent)
		return true
	}

	/**
	 * Set or clear an admin override for the given memberId. Affects every
	 * connected session for that member (a Member with multiple WS sessions
	 * for the same id is rare, but still possible during a fast reconnect).
	 *
	 * `override === null` clears any active override.
	 */
	setOverride(memberId: string, override: ScheduleOverride | null): number {
		let updated = 0
		for (const m of this.bySession.values()) {
			if (m.memberId !== memberId) continue
			m.override = override
			m.lastHeartbeat = new Date()
			this.scheduleTicker(m)
			this.emitter.emit('event', {
				type: 'member.updated',
				member: snapshotConnected(m),
			} satisfies RegistryEvent)
			updated++
		}
		return updated
	}

	/**
	 * Effective skills for `sessionId` right now. Used by the dispatcher to
	 * gate task assignment; clears any expired override on read so the
	 * registry doesn't accumulate dead overrides.
	 */
	effectiveSkills(sessionId: string, now: Date = new Date()): readonly Skill[] {
		const m = this.bySession.get(sessionId)
		if (!m) return []
		if (m.override && m.override.expiresAt.getTime() <= now.getTime()) {
			m.override = null
			this.emitter.emit('event', {
				type: 'member.updated',
				member: snapshotConnected(m, now),
			} satisfies RegistryEvent)
		}
		return effectiveSkillsAt(m.skills, m.schedule, m.override, now)
	}

	touch(sessionId: string): void {
		const m = this.bySession.get(sessionId)
		if (!m) return
		m.lastHeartbeat = new Date()
		this.persistence?.touch(m.memberId, m.lastHeartbeat)
	}

	get(sessionId: string): ConnectedMember | undefined {
		return this.bySession.get(sessionId)
	}

	findByMemberId(memberId: string): ConnectedMember[] {
		return [...this.bySession.values()].filter((m) => m.memberId === memberId)
	}

	/**
	 * Resolve a live connection for a task whose `assignedSessionId` may have
	 * gone stale across a reconnect. Tries the session first; if that's gone,
	 * falls back to the most recent live session for `memberId`.
	 */
	findConnectionForTask(
		sessionId: string | null,
		memberId: string | null,
	): ConnectedMember | undefined {
		if (sessionId) {
			const direct = this.bySession.get(sessionId)
			if (direct) return direct
		}
		if (memberId) {
			const live = this.findByMemberId(memberId)
			if (live.length > 0) {
				return live.reduce((best, m) => (m.lastHeartbeat > best.lastHeartbeat ? m : best))
			}
		}
		return undefined
	}

	list(): MemberSnapshot[] {
		const now = new Date()
		return [...this.bySession.values()].map((m) => snapshotConnected(m, now))
	}

	on(listener: (event: RegistryEvent) => void): () => void {
		this.emitter.on('event', listener)
		return () => {
			this.emitter.off('event', listener)
		}
	}

	/**
	 * (Re)arm the per-session timer that fires at the next schedule edge or
	 * override expiry, whichever comes first. On fire, re-emits
	 * `member.updated` (so the UI sees fresh effective skills + countdown)
	 * and pokes the dispatcher.
	 *
	 * Floored at 1s so a stale `nextTransitionAt` from a slow build can't
	 * spin a tight loop.
	 */
	private scheduleTicker(m: ConnectedMember): void {
		this.clearTicker(m.sessionId)
		const now = new Date()
		const scheduleEdge = nextTransition(m.schedule, now)
		const overrideExpiry = m.override ? m.override.expiresAt : null
		const target =
			overrideExpiry && overrideExpiry.getTime() < scheduleEdge.getTime()
				? overrideExpiry
				: scheduleEdge
		const delay = Math.max(1_000, target.getTime() - now.getTime())
		const timer = this.setTimeoutFn(() => {
			this.tickers.delete(m.sessionId)
			this.handleScheduleEdge(m.sessionId)
		}, delay)
		const t = timer as { unref?: () => void }
		if (typeof t.unref === 'function') t.unref()
		this.tickers.set(m.sessionId, timer)
	}

	private clearTicker(sessionId: string): void {
		const t = this.tickers.get(sessionId)
		if (t) {
			this.clearTimeoutFn(t)
			this.tickers.delete(sessionId)
		}
	}

	private handleScheduleEdge(sessionId: string): void {
		const m = this.bySession.get(sessionId)
		if (!m) return
		const now = new Date()
		// Drop any expired override eagerly so the snapshot below reflects it.
		if (m.override && m.override.expiresAt.getTime() <= now.getTime()) {
			m.override = null
		}
		this.scheduleTicker(m)
		this.emitter.emit('event', {
			type: 'member.updated',
			member: snapshotConnected(m, now),
		} satisfies RegistryEvent)
		this.onScheduleTick?.(sessionId)
	}
}
