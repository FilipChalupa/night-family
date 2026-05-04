import { describe, expect, it } from 'vitest'
import {
	defaultScheduleYaml,
	evaluateSchedule,
	nextTransition,
	parseSchedule,
	type Schedule,
} from './schedule.ts'

const TZ = 'Europe/Prague'

function localDate(iso: string, tz = TZ): Date {
	// Build a UTC instant by treating `iso` (`YYYY-MM-DDTHH:MM`) as wall-clock
	// time in `tz`. We need this for tests so we can write "Wednesday 03:00
	// Prague" without juggling DST math by hand.
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
	baseline: ['review', 'estimate', 'respond', 'summarize'],
	windows: [
		{
			name: 'night',
			days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
			start: '22:00',
			end: '08:00',
			skills: ['implement', 'review', 'estimate', 'respond', 'summarize'],
		},
		{
			name: 'lunch',
			days: ['mon', 'tue', 'wed', 'thu', 'fri'],
			start: '12:00',
			end: '13:00',
			skills: ['implement'],
		},
	],
}

describe('evaluateSchedule', () => {
	it('returns baseline at 10:00 on a Wednesday', () => {
		const r = evaluateSchedule(SCHEDULE, localDate('2026-04-08T10:00'))
		expect(r.activeName).toBe('baseline')
		expect(r.skills).toEqual(['review', 'estimate', 'respond', 'summarize'])
	})

	it('matches `night` at 23:30 (late part of wrap window)', () => {
		const r = evaluateSchedule(SCHEDULE, localDate('2026-04-08T23:30'))
		expect(r.activeName).toBe('night')
		expect(r.skills).toContain('implement')
	})

	it('matches `night` at 03:00 (early part of yesterday-started wrap)', () => {
		const r = evaluateSchedule(SCHEDULE, localDate('2026-04-09T03:00'))
		expect(r.activeName).toBe('night')
	})

	it('lunch overrides baseline on weekdays', () => {
		const r = evaluateSchedule(SCHEDULE, localDate('2026-04-08T12:30'))
		expect(r.activeName).toBe('lunch')
		expect(r.skills).toEqual(['implement'])
	})

	it('lunch is skipped on weekends (no `sat` in days)', () => {
		const r = evaluateSchedule(SCHEDULE, localDate('2026-04-11T12:30'))
		expect(r.activeName).toBe('baseline')
	})

	it('end is exclusive (08:00 sharp = baseline)', () => {
		const r = evaluateSchedule(SCHEDULE, localDate('2026-04-08T08:00'))
		expect(r.activeName).toBe('baseline')
	})

	it('start is inclusive (22:00 sharp = night)', () => {
		const r = evaluateSchedule(SCHEDULE, localDate('2026-04-08T22:00'))
		expect(r.activeName).toBe('night')
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
		const empty: Schedule = { timezone: TZ, baseline: ['review'], windows: [] }
		const now = localDate('2026-04-08T10:00')
		const t = nextTransition(empty, now)
		const expected = now.getTime() + 7 * 24 * 60 * 60 * 1000
		expect(Math.abs(t.getTime() - expected)).toBeLessThan(1000)
	})
})

describe('parseSchedule', () => {
	it('parses a minimal valid YAML', () => {
		const s = parseSchedule(`
timezone: Europe/Prague
baseline: [review, respond]
windows:
  - name: night
    start: "22:00"
    end: "08:00"
    skills: [implement, review]
`)
		expect(s.timezone).toBe('Europe/Prague')
		expect(s.baseline).toEqual(['review', 'respond'])
		expect(s.windows).toHaveLength(1)
		expect(s.windows[0]?.name).toBe('night')
		expect(s.windows[0]?.days).toHaveLength(7)
	})

	it('parses the default YAML emitted by init-schedule', () => {
		const s = parseSchedule(defaultScheduleYaml())
		expect(s.windows.map((w) => w.name)).toEqual(['night', 'lunch'])
	})

	it('rejects unknown skill values with a useful path', () => {
		expect(() =>
			parseSchedule(`
timezone: UTC
baseline: [review, deploy]
`),
		).toThrow(/baseline\[1\]/)
	})

	it('rejects bogus HH:MM', () => {
		expect(() =>
			parseSchedule(`
timezone: UTC
baseline: [review]
windows:
  - name: x
    start: "25:00"
    end: "08:00"
    skills: [implement]
`),
		).toThrow(/start/)
	})

	it('rejects an unknown timezone', () => {
		expect(() =>
			parseSchedule(`
timezone: Mars/Olympus
baseline: [review]
`),
		).toThrow(/timezone/)
	})
})
