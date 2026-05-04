import type { Logger } from 'pino'
import type { Skill } from '@night/shared'
import { isNightAt, nextTransition, type Schedule } from './schedule.ts'

/**
 * Owns the live "what skills does this Member offer right now?" state.
 *
 * Combines:
 *   - the configured skill set (from `SKILLS` env, default = all),
 *   - the static `Schedule` (loaded from YAML or built-in defaults), which
 *     gates the `implement` skill in time, and
 *   - an optional ephemeral override pushed by Household ("force
 *     implement-mode for the next 2 hours") with an expiry timestamp.
 *
 * Effective rule with no override:
 *   any nightWindow active  →  fullSkills
 *   no nightWindow active   →  fullSkills minus `implement`
 *
 * `triage` is therefore always offered (regardless of the schedule),
 * because it's never the gated skill — only `implement` ever drops out.
 * That matches the workflow: triage runs in the day to clarify or plan;
 * implementation runs at night once a plan exists.
 *
 * Override replaces both with the supplied skill set until expiry. Every
 * change to the effective set fires `onChange(skills, reason)`. The
 * wiring in `connection.ts` translates that into a `member.skills_updated`
 * wire message when the WS is open. Transitions that fire while
 * disconnected stay in `effectiveSkills()` so the next handshake carries
 * the right value.
 */

export interface ScheduleControllerOpts {
	schedule: Schedule
	/** Skill set the Member is configured to do at all (from `SKILLS` env). */
	fullSkills: readonly Skill[]
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

export class ScheduleController {
	private current: readonly Skill[]
	private override: Override | null = null
	private timer: NodeJS.Timeout | null = null
	private readonly schedule: Schedule
	private readonly fullSkills: readonly Skill[]
	private readonly daySkills: readonly Skill[]
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
		this.fullSkills = [...opts.fullSkills]
		this.daySkills = this.fullSkills.filter((s) => s !== 'implement')
		this.onChange = opts.onChange
		this.logger = opts.logger
		this.now = opts.now ?? (() => new Date())
		this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout
		this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout
		this.current = this.computeFromSchedule(this.now()).skills
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
		this.override = { skills: [...skills], expiresAt }
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

	private computeFromSchedule(now: Date): { skills: readonly Skill[]; activeName: string } {
		const { active, window } = isNightAt(this.schedule, now)
		if (active) return { skills: this.fullSkills, activeName: window ?? 'night' }
		return { skills: this.daySkills, activeName: 'day' }
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
			: this.computeFromSchedule(now)
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
