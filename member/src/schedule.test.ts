import { describe, expect, it } from 'vitest'
import { defaultScheduleYaml, parseSchedule } from './schedule.ts'

describe('parseSchedule', () => {
	it('parses a minimal valid YAML', () => {
		const s = parseSchedule(`
timezone: Europe/Prague
nightWindows:
  - name: night
    start: "22:00"
    end: "08:00"
`)
		expect(s.timezone).toBe('Europe/Prague')
		expect(s.nightWindows).toHaveLength(1)
		expect(s.nightWindows[0]?.name).toBe('night')
	})

	it('parses the default YAML emitted by init-schedule', () => {
		const s = parseSchedule(defaultScheduleYaml())
		expect(s.nightWindows.map((w) => w.name)).toEqual(['night', 'lunch'])
	})

	it('rejects mixing days and dates on one window', () => {
		expect(() =>
			parseSchedule(`
timezone: UTC
nightWindows:
  - name: x
    days: [mon]
    dates: ['2026-04-08']
    start: "10:00"
    end: "11:00"
`),
		).toThrow(/either `days` or `dates`/)
	})

	it('rejects bogus HH:MM', () => {
		expect(() =>
			parseSchedule(`
timezone: UTC
nightWindows:
  - name: x
    start: "25:00"
    end: "08:00"
`),
		).toThrow(/start/)
	})

	it('rejects bogus calendar date', () => {
		expect(() =>
			parseSchedule(`
timezone: UTC
nightWindows:
  - name: x
    dates: ["2026-13-40"]
`),
		).toThrow(/dates/)
	})

	it('rejects an unknown timezone', () => {
		expect(() =>
			parseSchedule(`
timezone: Mars/Olympus
nightWindows: []
`),
		).toThrow(/timezone/)
	})

	it('defaults missing start/end to all-day', () => {
		const s = parseSchedule(`
timezone: UTC
nightWindows:
  - name: weekend
    days: [sat, sun]
`)
		expect(s.nightWindows[0]?.start).toBe('00:00')
		expect(s.nightWindows[0]?.end).toBe('24:00')
	})
})
