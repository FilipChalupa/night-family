import { describe, expect, it } from 'vitest'
import type { Schedule } from '@night/shared'
import { effectiveSkillsAt, isNightAt, nextTransition } from './eval.ts'

const TZ = 'Europe/Prague'

function localDate(iso: string, tz = TZ): Date {
	// Build a UTC instant by treating `iso` (`YYYY-MM-DDTHH:MM`) as wall-clock
	// time in `tz`. We need this so tests can write "Wednesday 03:00 Prague"
	// without juggling DST math by hand.
	const [datePart, timePart] = iso.split('T')
	const [y, mo, d] = datePart!.split('-').map(Number)
	const [h, mi] = timePart!.split(':').map(Number)
	let guess = Date.UTC(y!, mo! - 1, d!, h!, mi!)
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	})
	for (let i = 0; i < 3; i++) {
		const parts = Object.fromEntries(
			fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
		)
		const observed = {
			y: Number(parts.year),
			mo: Number(parts.month),
			d: Number(parts.day),
			h: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
			mi: Number(parts.minute),
		}
		const drift =
			(observed.y - y!) * 525_600 +
			(observed.mo - mo!) * 43_200 +
			(observed.d - d!) * 1_440 +
			(observed.h - h!) * 60 +
			(observed.mi - mi!)
		if (drift === 0) return new Date(guess)
		guess -= drift * 60_000
	}
	return new Date(guess)
}

const SCHEDULE: Schedule = {
	timezone: TZ,
	nightWindows: [
		{ name: 'night', start: '22:00', end: '08:00' },
		{ name: 'lunch', days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '12:00', end: '13:00' },
	],
}

describe('isNightAt', () => {
	it('inactive at 10:00 on a Wednesday', () => {
		const r = isNightAt(SCHEDULE, localDate('2026-04-08T10:00'))
		expect(r.active).toBe(false)
		expect(r.window).toBeNull()
	})

	it('active at 23:30 (late part of wrap window)', () => {
		const r = isNightAt(SCHEDULE, localDate('2026-04-08T23:30'))
		expect(r.active).toBe(true)
		expect(r.window).toBe('night')
	})

	it('active at 03:00 (early part of yesterday-started wrap)', () => {
		const r = isNightAt(SCHEDULE, localDate('2026-04-09T03:00'))
		expect(r.active).toBe(true)
		expect(r.window).toBe('night')
	})

	it('lunch active on weekdays', () => {
		const r = isNightAt(SCHEDULE, localDate('2026-04-08T12:30'))
		expect(r.active).toBe(true)
		expect(r.window).toBe('lunch')
	})

	it('lunch skipped on weekends', () => {
		const r = isNightAt(SCHEDULE, localDate('2026-04-11T12:30'))
		expect(r.active).toBe(false)
	})

	it('end is exclusive (08:00 sharp = inactive)', () => {
		const r = isNightAt(SCHEDULE, localDate('2026-04-08T08:00'))
		expect(r.active).toBe(false)
	})

	it('start is inclusive (22:00 sharp = active)', () => {
		const r = isNightAt(SCHEDULE, localDate('2026-04-08T22:00'))
		expect(r.active).toBe(true)
	})

	it('matches a calendar-date window all day by default', () => {
		const dateOnly: Schedule = {
			timezone: TZ,
			nightWindows: [
				{ name: 'vacation', dates: ['2026-07-15'], start: '00:00', end: '24:00' },
			],
		}
		expect(isNightAt(dateOnly, localDate('2026-07-15T00:00')).active).toBe(true)
		expect(isNightAt(dateOnly, localDate('2026-07-15T23:59')).active).toBe(true)
		expect(isNightAt(dateOnly, localDate('2026-07-16T00:00')).active).toBe(false)
		expect(isNightAt(dateOnly, localDate('2026-07-14T23:59')).active).toBe(false)
	})

	it('date-anchored window respects start/end', () => {
		const dateBlock: Schedule = {
			timezone: TZ,
			nightWindows: [
				{ name: 'evening', dates: ['2026-07-15'], start: '18:00', end: '23:00' },
			],
		}
		expect(isNightAt(dateBlock, localDate('2026-07-15T18:30')).active).toBe(true)
		expect(isNightAt(dateBlock, localDate('2026-07-15T23:00')).active).toBe(false)
		expect(isNightAt(dateBlock, localDate('2026-07-15T17:59')).active).toBe(false)
	})
})

describe('nextTransition', () => {
	it('day → night transition fires at 22:00 same day', () => {
		const now = localDate('2026-04-08T15:00')
		const t = nextTransition(SCHEDULE, now)
		expect(t.getTime()).toBe(localDate('2026-04-08T22:00').getTime())
	})

	it('inside lunch, next transition is lunch end (13:00)', () => {
		const now = localDate('2026-04-08T12:30')
		const t = nextTransition(SCHEDULE, now)
		expect(t.getTime()).toBe(localDate('2026-04-08T13:00').getTime())
	})

	it('inside night (03:00), next transition is 08:00 same day', () => {
		const now = localDate('2026-04-09T03:00')
		const t = nextTransition(SCHEDULE, now)
		expect(t.getTime()).toBe(localDate('2026-04-09T08:00').getTime())
	})

	it('result is strictly after `now` (boundary case)', () => {
		const now = localDate('2026-04-08T22:00') // sharp window start
		const t = nextTransition(SCHEDULE, now)
		expect(t.getTime()).toBeGreaterThan(now.getTime())
	})

	it('returns 7-day horizon when no windows defined', () => {
		const empty: Schedule = { timezone: TZ, nightWindows: [] }
		const now = localDate('2026-04-08T10:00')
		const t = nextTransition(empty, now)
		const expected = now.getTime() + 7 * 24 * 60 * 60 * 1000
		expect(Math.abs(t.getTime() - expected)).toBeLessThan(1000)
	})
})

describe('effectiveSkillsAt', () => {
	const FULL = ['implement', 'review', 'triage', 'respond', 'summarize'] as const

	it('drops implement during the day', () => {
		const now = localDate('2026-04-08T10:00') // Wed 10:00
		const out = effectiveSkillsAt(FULL, SCHEDULE, null, now)
		expect(out).toEqual(['review', 'triage', 'respond', 'summarize'])
	})

	it('keeps everything inside the night window', () => {
		const now = localDate('2026-04-08T23:30')
		const out = effectiveSkillsAt(FULL, SCHEDULE, null, now)
		expect(out).toEqual([...FULL])
	})

	it('an active override replaces the schedule decision', () => {
		const now = localDate('2026-04-08T10:00') // would be day → no implement
		const expiresAt = new Date(now.getTime() + 60 * 60 * 1000)
		const out = effectiveSkillsAt(FULL, SCHEDULE, { skills: ['implement'], expiresAt }, now)
		expect(out).toEqual(['implement'])
	})

	it("an override can't grant a skill the member doesn't run", () => {
		const now = localDate('2026-04-08T10:00')
		const expiresAt = new Date(now.getTime() + 60 * 60 * 1000)
		const subset = ['review', 'triage'] as const
		const out = effectiveSkillsAt(subset, SCHEDULE, { skills: ['implement'], expiresAt }, now)
		expect(out).toEqual([])
	})

	it('an expired override is ignored', () => {
		const now = localDate('2026-04-08T10:00')
		const expiresAt = new Date(now.getTime() - 60 * 60 * 1000)
		const out = effectiveSkillsAt(FULL, SCHEDULE, { skills: ['implement'], expiresAt }, now)
		expect(out).toEqual(['review', 'triage', 'respond', 'summarize'])
	})
})
