import { describe, expect, it } from 'vitest'
import pino from 'pino'
import { ALL_SKILLS, type Skill } from '@night/shared'
import { ScheduleController } from './scheduleController.ts'
import type { Schedule } from './schedule.ts'

const SILENT_LOGGER = pino({ level: 'silent' })

const TZ = 'UTC'

const SCHEDULE: Schedule = {
	timezone: TZ,
	nightWindows: [{ name: 'night', start: '22:00', end: '08:00' }],
}

const FULL_SKILLS = [...ALL_SKILLS]

class FakeClock {
	now: Date
	private timers: Array<{ id: NodeJS.Timeout; fireAt: number; cb: () => void }> = []
	private nextId = 1

	constructor(start: Date) {
		this.now = new Date(start)
	}

	setTimeout = (cb: () => void, ms: number): NodeJS.Timeout => {
		const id = { __id: this.nextId++ } as unknown as NodeJS.Timeout
		this.timers.push({ id, fireAt: this.now.getTime() + ms, cb })
		this.timers.sort((a, b) => a.fireAt - b.fireAt)
		return id
	}

	clearTimeout = (id: NodeJS.Timeout): void => {
		this.timers = this.timers.filter((t) => t.id !== id)
	}

	advanceTo(target: Date): void {
		while (this.timers.length > 0 && this.timers[0]!.fireAt <= target.getTime()) {
			const t = this.timers.shift()!
			this.now = new Date(t.fireAt)
			t.cb()
		}
		this.now = new Date(target)
	}
}

function makeController(start: Date, fullSkills: readonly Skill[] = FULL_SKILLS) {
	const clock = new FakeClock(start)
	const events: Array<{ skills: readonly Skill[]; reason: string }> = []
	const c = new ScheduleController({
		schedule: SCHEDULE,
		fullSkills,
		onChange: (skills, reason) => events.push({ skills: [...skills], reason }),
		logger: SILENT_LOGGER,
		now: () => clock.now,
		setTimeoutFn: clock.setTimeout,
		clearTimeoutFn: clock.clearTimeout,
	})
	c.start()
	return { controller: c, clock, events }
}

describe('ScheduleController', () => {
	it('day mode drops `implement` from the configured set', () => {
		const { controller } = makeController(new Date('2026-04-08T10:00:00Z'))
		expect([...controller.effectiveSkills()].sort()).toEqual(
			['estimate', 'respond', 'review', 'summarize'].sort(),
		)
	})

	it('night window adds `implement` back', () => {
		const { controller } = makeController(new Date('2026-04-08T23:00:00Z'))
		expect([...controller.effectiveSkills()].sort()).toEqual([...ALL_SKILLS].sort())
	})

	it('emits skills_updated when the timer fires across a transition', () => {
		const { clock, events } = makeController(new Date('2026-04-08T21:59:00Z'))
		clock.advanceTo(new Date('2026-04-08T22:00:30Z'))
		expect(events).toHaveLength(1)
		expect(events[0]?.reason).toBe('schedule:night')
		expect(events[0]?.skills).toContain('implement')
	})

	it('override takes immediate effect and emits with reason "override"', () => {
		const { controller, clock, events } = makeController(new Date('2026-04-08T10:00:00Z'))
		const expires = new Date(clock.now.getTime() + 60 * 60 * 1000)
		controller.setOverride(['implement'], expires)
		expect(events.at(-1)?.reason).toBe('override')
		expect([...controller.effectiveSkills()]).toEqual(['implement'])
	})

	it('override expiry restores schedule and emits "override_expired"', () => {
		const ctrl = makeController(new Date('2026-04-08T10:00:00Z'))
		const expires = new Date(ctrl.clock.now.getTime() + 30 * 60 * 1000)
		ctrl.controller.setOverride(['implement'], expires)
		ctrl.clock.advanceTo(new Date(expires.getTime() + 1_000))
		const reasons = ctrl.events.map((e) => e.reason)
		expect(reasons).toContain('override_expired')
		// Day mode → no implement.
		expect([...ctrl.controller.effectiveSkills()]).not.toContain('implement')
	})

	it('clearOverride before expiry emits "override_cleared"', () => {
		const { controller, clock, events } = makeController(new Date('2026-04-08T10:00:00Z'))
		controller.setOverride(['implement'], new Date(clock.now.getTime() + 60 * 60 * 1000))
		controller.clearOverride()
		expect(events.at(-1)?.reason).toBe('override_cleared')
	})

	it('does not emit when override skills equal the active set', () => {
		const { controller, clock, events } = makeController(new Date('2026-04-08T23:00:00Z'))
		// Already night → full skills.
		const before = events.length
		controller.setOverride([...ALL_SKILLS], new Date(clock.now.getTime() + 30 * 60 * 1000))
		expect(events.length).toBe(before)
	})

	it('member with `SKILLS=review` (no implement configured) is unaffected by night window', () => {
		const { clock, events } = makeController(new Date('2026-04-08T21:59:00Z'), ['review'])
		clock.advanceTo(new Date('2026-04-08T22:30:00Z'))
		// No transition events — implement was never in fullSkills.
		expect(events).toHaveLength(0)
	})
})
