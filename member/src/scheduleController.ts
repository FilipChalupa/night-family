import type { Logger } from 'pino'
import type { Skill } from '@night/shared'
import { evaluateSchedule, nextTransition, type Schedule } from './schedule.ts'

/**
 * Owns the live "what skills does this Member offer right now?" state.
 *
 * Combines:
 *   - the static `Schedule` (loaded from YAML or built-in defaults), and
 *   - an optional ephemeral override pushed by Household ("force
 *     implement-mode for the next 2 hours") with an expiry timestamp.
 *
 * Every time the effective set changes — schedule transition fired,
 * override installed, override cleared, override expired — the controller
 * calls `onChange(skills, reason)`. The wiring in `connection.ts`
 * translates that into a `member.skills_updated` wire message when the WS
 * is open. Transitions that fire while disconnected are still recorded in
 * internal state, so the next handshake carries the right `skills`.
 */

export interface ScheduleControllerOpts {
	schedule: Schedule
	onChange: (skills: readonly Skill[], reason: string) => void
	logger: Logger
	/** Test seam. Defaults to `() => new Date()`. */
	now?: () => Date
	/** Test seam. Defaults to `setTimeout`. */
	setTimeoutFn?: (cb: () => void, ms: number) => NodeJS.Timeout
	clearTimeoutFn?: (t: NodeJS.Timeout) => void
}

interface Override {
	skills: readonly Skill[]
	expiresAt: Date
}

export interface ScheduleStatus {
	skills: readonly Skill[]
	activeName: string
	scheduleEvalAt: string
	override: { skills: readonly Skill[]; expiresAt: string } | null
	nextTransitionAt: string
}

export class ScheduleController {
	private current: readonly Skill[]
	private override: Override | null = null
	private timer: NodeJS.Timeout | null = null
	private readonly schedule: Schedule
	/**
	 * Public to allow late wiring: `connection.ts` constructs the controller
	 * before it has access to the WS send function, then replaces this
	 * callback to forward changes onto the wire.
	 */
	onChange: ScheduleControllerOpts['onChange']
	private readonly logger: Logger
	private readonly now: () => Date
	private readonly setTimeoutFn: NonNullable<ScheduleControllerOpts['setTimeoutFn']>
	private readonly clearTimeoutFn: NonNullable<ScheduleControllerOpts['clearTimeoutFn']>

	constructor(opts: ScheduleControllerOpts) {
		this.schedule = opts.schedule
		this.onChange = opts.onChange
		this.logger = opts.logger
		this.now = opts.now ?? (() => new Date())
		this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout
		this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout
		const initial = evaluateSchedule(this.schedule, this.now())
		this.current = initial.skills
	}

	start(): void {
		this.scheduleNextTick()
	}

	stop(): void {
		this.clearTimer()
	}

	effectiveSkills(): readonly Skill[] {
		return this.current
	}

	setOverride(skills: readonly Skill[], expiresAt: Date): void {
		if (expiresAt.getTime() <= this.now().getTime()) {
			this.logger.warn(
				{ expiresAt: expiresAt.toISOString() },
				'override expiry already in the past; ignoring',
			)
			return
		}
		this.override = { skills, expiresAt }
		this.logger.info(
			{ skills, expiresAt: expiresAt.toISOString() },
			'schedule override installed',
		)
		this.recompute('override')
	}

	clearOverride(): void {
		if (!this.override) return
		this.override = null
		this.logger.info('schedule override cleared')
		this.recompute('override_cleared')
	}

	status(): ScheduleStatus {
		const now = this.now()
		const ev = evaluateSchedule(this.schedule, now)
		return {
			skills: this.current,
			activeName: this.override ? 'override' : ev.activeName,
			scheduleEvalAt: now.toISOString(),
			override: this.override
				? {
						skills: this.override.skills,
						expiresAt: this.override.expiresAt.toISOString(),
					}
				: null,
			nextTransitionAt: this.computeNextEdge(now).toISOString(),
		}
	}

	private recompute(reasonHint: 'override' | 'override_cleared' | 'tick'): void {
		const now = this.now()
		let detectedExpiry = false
		if (this.override && this.override.expiresAt.getTime() <= now.getTime()) {
			this.override = null
			detectedExpiry = true
		}
		const next = this.override
			? { skills: this.override.skills, activeName: 'override' as const }
			: evaluateSchedule(this.schedule, now)
		if (!skillsEqual(this.current, next.skills)) {
			this.current = next.skills
			let reason: string
			if (reasonHint === 'override') reason = 'override'
			else if (reasonHint === 'override_cleared') reason = 'override_cleared'
			else if (detectedExpiry) reason = 'override_expired'
			else reason = `schedule:${next.activeName}`
			this.onChange(this.current, reason)
		}
		this.scheduleNextTick()
	}

	private scheduleNextTick(): void {
		this.clearTimer()
		const now = this.now()
		const edge = this.computeNextEdge(now)
		const delay = Math.max(1_000, edge.getTime() - now.getTime())
		this.timer = this.setTimeoutFn(() => this.recompute('tick'), delay)
		const t = this.timer as { unref?: () => void }
		if (typeof t.unref === 'function') t.unref()
	}

	private computeNextEdge(now: Date): Date {
		const scheduleEdge = nextTransition(this.schedule, now)
		if (this.override && this.override.expiresAt.getTime() > now.getTime()) {
			if (this.override.expiresAt.getTime() < scheduleEdge.getTime()) {
				return this.override.expiresAt
			}
		}
		return scheduleEdge
	}

	private clearTimer(): void {
		if (this.timer) {
			this.clearTimeoutFn(this.timer)
			this.timer = null
		}
	}
}

function skillsEqual(a: readonly Skill[], b: readonly Skill[]): boolean {
	if (a.length !== b.length) return false
	const sa = new Set(a)
	for (const x of b) if (!sa.has(x)) return false
	return true
}
