import type { Day, NightWindow, Schedule, Skill } from '@night/shared'

/**
 * Pure schedule-evaluation logic. The Member ships its parsed
 * {@link Schedule} on handshake; everything below decides, given the
 * current wall-clock and (optionally) an admin override, whether the
 * Member is willing to take an `implement` task right now and when its
 * answer will next change.
 *
 * Members no longer evaluate their own schedule; this module is the
 * single source of truth used by the dispatcher and the dashboard.
 */

const ALL_DAYS: readonly Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_END = '24:00'

/**
 * Admin-driven override: forces a specific skill set to be advertised
 * regardless of the schedule until `expiresAt`. Held entirely in
 * Household memory now (per protocol 3.0.0); the Member is never told.
 */
export interface ScheduleOverride {
	skills: readonly Skill[]
	expiresAt: Date
}

/**
 * What kinds is this Member willing to take *right now*, derived from
 * its static `fullSkills`, the active schedule, and any admin override.
 */
export function effectiveSkillsAt(
	fullSkills: readonly Skill[],
	schedule: Schedule,
	override: ScheduleOverride | null,
	now: Date,
): readonly Skill[] {
	if (override && override.expiresAt.getTime() > now.getTime()) {
		// Honor the override only to the extent the Member's static
		// capability allows; an override can't summon a skill the Member
		// doesn't run.
		const allowed = new Set(fullSkills)
		return override.skills.filter((s) => allowed.has(s))
	}
	const { active } = isNightAt(schedule, now)
	if (active) return fullSkills
	return fullSkills.filter((s) => s !== 'implement')
}

/**
 * Is *any* night-window active at the given moment?
 */
export function isNightAt(
	schedule: Schedule,
	now: Date,
): { active: boolean; window: string | null } {
	for (const w of schedule.nightWindows) {
		if (windowContains(w, now, schedule.timezone)) {
			return { active: true, window: w.name }
		}
	}
	return { active: false, window: null }
}

/**
 * Compute the next moment, strictly after `now`, at which {@link isNightAt}
 * could flip. Bounded by 7 days into the future so an empty schedule
 * still keeps the timer alive weekly.
 */
export function nextTransition(schedule: Schedule, now: Date): Date {
	const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
	let earliest: Date | null = null
	for (const w of schedule.nightWindows) {
		for (const edge of windowEdges(w, schedule.timezone, now)) {
			if (edge.getTime() <= now.getTime()) continue
			if (edge.getTime() > horizon.getTime()) continue
			if (!earliest || edge.getTime() < earliest.getTime()) earliest = edge
		}
	}
	return earliest ?? horizon
}

interface LocalDateParts {
	year: number
	month: number
	day: number
	hour: number
	minute: number
	weekday: Day
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>()
function localFormatter(timezone: string): Intl.DateTimeFormat {
	let f = FORMATTER_CACHE.get(timezone)
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			weekday: 'short',
			hour12: false,
		})
		FORMATTER_CACHE.set(timezone, f)
	}
	return f
}

const WEEKDAY_NAME_TO_DAY: Record<string, Day> = {
	Mon: 'mon',
	Tue: 'tue',
	Wed: 'wed',
	Thu: 'thu',
	Fri: 'fri',
	Sat: 'sat',
	Sun: 'sun',
}

function localParts(now: Date, timezone: string): LocalDateParts {
	const fmt = localFormatter(timezone)
	const parts = Object.fromEntries(
		fmt.formatToParts(now).map((p) => [p.type, p.value]),
	) as Record<string, string>
	const weekday = WEEKDAY_NAME_TO_DAY[parts.weekday ?? ''] ?? 'mon'
	let hour = Number(parts.hour ?? '0')
	if (hour === 24) hour = 0
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour,
		minute: Number(parts.minute),
		weekday,
	}
}

function isoDate(p: { year: number; month: number; day: number }): string {
	return `${p.year.toString().padStart(4, '0')}-${p.month.toString().padStart(2, '0')}-${p.day
		.toString()
		.padStart(2, '0')}`
}

function timeMinutes(t: string): number {
	if (t === DAY_END) return 1440
	const [h, m] = t.split(':')
	return Number(h) * 60 + Number(m)
}

function localTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timezone: string,
): Date {
	let guess = Date.UTC(year, month - 1, day, hour, minute)
	for (let i = 0; i < 3; i++) {
		const parts = localParts(new Date(guess), timezone)
		const drift =
			(parts.year - year) * 525_600 +
			(parts.month - month) * 43_200 +
			(parts.day - day) * 1_440 +
			(parts.hour - hour) * 60 +
			(parts.minute - minute)
		if (drift === 0) return new Date(guess)
		guess -= drift * 60_000
	}
	return new Date(guess)
}

function windowMatchesAnchor(w: NightWindow, anchor: { weekday: Day; date: string }): boolean {
	if (w.dates) return w.dates.includes(anchor.date)
	if (w.days) return w.days.includes(anchor.weekday)
	return true
}

function windowContains(w: NightWindow, now: Date, timezone: string): boolean {
	const np = localParts(now, timezone)
	const startMin = timeMinutes(w.start)
	const endMin = timeMinutes(w.end)
	const nowMin = np.hour * 60 + np.minute
	const todayAnchor = { weekday: np.weekday, date: isoDate(np) }
	if (startMin < endMin) {
		// Same-day window.
		if (!windowMatchesAnchor(w, todayAnchor)) return false
		return nowMin >= startMin && nowMin < endMin
	}
	// Wrap-midnight window: started either today or yesterday.
	if (nowMin >= startMin && windowMatchesAnchor(w, todayAnchor)) return true
	if (nowMin < endMin) {
		const yesterday = addLocalDays(
			{ year: np.year, month: np.month, day: np.day },
			-1,
			timezone,
		)
		const yAnchor = { weekday: prevDay(np.weekday), date: isoDate(yesterday) }
		if (windowMatchesAnchor(w, yAnchor)) return true
	}
	return false
}

function prevDay(d: Day): Day {
	const idx = ALL_DAYS.indexOf(d)
	return ALL_DAYS[(idx + ALL_DAYS.length - 1) % ALL_DAYS.length]!
}

function addLocalDays(
	p: { year: number; month: number; day: number },
	days: number,
	timezone: string,
): { year: number; month: number; day: number } {
	const utcMid = Date.UTC(p.year, p.month - 1, p.day, 12, 0)
	const shifted = new Date(utcMid + days * 24 * 60 * 60 * 1000)
	const parts = localParts(shifted, timezone)
	return { year: parts.year, month: parts.month, day: parts.day }
}

/**
 * Emit candidate edge timestamps (start + end) for occurrences of `w` in
 * the rolling week around `now`. The caller filters the past.
 *
 *   - For `days`-anchored windows, project each listed weekday onto
 *     `[-1, 0, +1]` weeks relative to `now`.
 *   - For `dates`-anchored windows, the listed dates are absolute, so we
 *     emit each one's start/end directly.
 */
function windowEdges(w: NightWindow, timezone: string, now: Date): Date[] {
	const out: Date[] = []
	const startMin = timeMinutes(w.start)
	const endMin = timeMinutes(w.end)
	const wraps = endMin <= startMin
	const np = localParts(now, timezone)

	const emit = (date: { year: number; month: number; day: number }) => {
		const startH = Math.floor(startMin / 60)
		const startMm = startMin % 60
		const endH = Math.floor(endMin / 60)
		const endMm = endMin % 60
		const startEdge = localTimeToUtc(date.year, date.month, date.day, startH, startMm, timezone)
		// `24:00` end of same day == `00:00` next day.
		const endRollOver = endMin === 1440
		const endDate = wraps || endRollOver ? addLocalDays(date, 1, timezone) : date
		const endHour = endRollOver ? 0 : endH
		const endMinute = endRollOver ? 0 : endMm
		out.push(
			startEdge,
			localTimeToUtc(endDate.year, endDate.month, endDate.day, endHour, endMinute, timezone),
		)
	}

	const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
	if (w.dates) {
		for (const d of w.dates) {
			const m = DATE_RE.exec(d)
			if (!m) continue
			emit({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) })
		}
		return out
	}

	const daysList = w.days ?? ALL_DAYS
	const todayIdx = ALL_DAYS.indexOf(np.weekday)
	for (const d of daysList) {
		const targetIdx = ALL_DAYS.indexOf(d)
		const baseDelta = (targetIdx - todayIdx + 7) % 7
		for (const weekOffset of [-1, 0, 1]) {
			const delta = baseDelta + weekOffset * 7
			const startDate = addLocalDays(
				{ year: np.year, month: np.month, day: np.day },
				delta,
				timezone,
			)
			emit(startDate)
		}
	}
	return out
}
