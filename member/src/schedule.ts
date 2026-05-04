import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

/**
 * Per-Member schedule that gates the `implement` skill in time. Skill
 * sets themselves come from `SKILLS` env (Member config); this module
 * only answers "is the Member willing to implement *right now*?".
 *
 *   - When *any* `nightWindow` is active in the local timezone, the
 *     Member offers everything in `SKILLS`.
 *   - Outside every window, `implement` is dropped from the offered set
 *     (other skills like `review` / `respond` keep flowing).
 *
 * Lookup chain for the YAML source (first hit wins):
 *
 *   1. `SCHEDULE_FILE` env var — explicit override, dev or prod.
 *   2. `/etc/night-family/schedule.yaml` — Docker bind-mount convention.
 *   3. `<repo-root>/schedule.yaml` — convenience for `npm run dev`.
 *
 * Nothing found = built-in default. Never throws on missing file; only
 * on malformed YAML or invalid shape.
 */

export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
const ALL_DAYS: readonly Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export interface NightWindow {
	name: string
	/** Match by local weekday of the window's start. Mutually exclusive with `dates`. */
	days?: readonly Day[]
	/** Match by exact local calendar date (`YYYY-MM-DD`). Mutually exclusive with `days`. */
	dates?: readonly string[]
	/** Local-time `HH:MM` of window start. Default `00:00`. */
	start: string
	/** Local-time `HH:MM` of window end (1440 minutes = end-of-day default). If `<= start`, wraps midnight. */
	end: string
}

export interface Schedule {
	/** IANA timezone identifier (e.g. `Europe/Prague`). */
	timezone: string
	nightWindows: readonly NightWindow[]
}

const FIXED_DOCKER_PATH = '/etc/night-family/schedule.yaml'
const DEFAULT_FILENAME = 'schedule.yaml'
const DAY_END = '24:00'

const BUILT_IN_DEFAULT: Schedule = {
	timezone: process.env.TZ || 'UTC',
	nightWindows: [
		{
			name: 'night',
			days: ALL_DAYS,
			start: '22:00',
			end: '08:00',
		},
		{
			name: 'lunch',
			days: ['mon', 'tue', 'wed', 'thu', 'fri'],
			start: '12:00',
			end: '13:00',
		},
	],
}

export interface ResolveScheduleResult {
	schedule: Schedule
	/** Absolute path of the source, or `null` for built-in default. */
	source: string | null
}

export function resolveSchedule(
	envSchedulePath: string | undefined = process.env.SCHEDULE_FILE,
): ResolveScheduleResult {
	if (envSchedulePath !== undefined && envSchedulePath !== '') {
		const path = isAbsolute(envSchedulePath) ? envSchedulePath : resolve(envSchedulePath)
		if (existsSync(path)) {
			return { schedule: parseSchedule(readFileSync(path, 'utf8')), source: path }
		}
		return { schedule: BUILT_IN_DEFAULT, source: null }
	}
	const candidates: string[] = [FIXED_DOCKER_PATH]
	const repoRoot = findRepoRoot()
	if (repoRoot) candidates.push(resolve(repoRoot, DEFAULT_FILENAME))
	for (const path of candidates) {
		if (!existsSync(path)) continue
		return { schedule: parseSchedule(readFileSync(path, 'utf8')), source: path }
	}
	return { schedule: BUILT_IN_DEFAULT, source: null }
}

export function parseSchedule(yaml: string): Schedule {
	const doc = parseYaml(yaml) as unknown
	if (!doc || typeof doc !== 'object') {
		throw new Error('schedule: top-level must be an object')
	}
	const o = doc as Record<string, unknown>
	const timezone = expectString(o.timezone, 'timezone')
	if (!isValidTimezone(timezone)) {
		throw new Error(`schedule.timezone: not a valid IANA timezone: ${timezone}`)
	}
	const raw = o.nightWindows
	if (raw !== undefined && !Array.isArray(raw)) {
		throw new Error('schedule.nightWindows: must be an array')
	}
	const nightWindows: NightWindow[] = []
	for (const [i, w] of (raw ?? []).entries()) {
		nightWindows.push(parseNightWindow(w, `nightWindows[${i}]`))
	}
	return { timezone, nightWindows }
}

function parseNightWindow(raw: unknown, ctx: string): NightWindow {
	if (!raw || typeof raw !== 'object') throw new Error(`${ctx}: must be an object`)
	const o = raw as Record<string, unknown>
	const name = expectString(o.name, `${ctx}.name`)
	const start = o.start === undefined ? '00:00' : expectTime(o.start, `${ctx}.start`)
	const end = o.end === undefined ? DAY_END : expectTime(o.end, `${ctx}.end`, { allow24: true })
	const hasDays = o.days !== undefined
	const hasDates = o.dates !== undefined
	if (hasDays && hasDates) {
		throw new Error(`${ctx}: specify either \`days\` or \`dates\`, not both`)
	}
	if (hasDays) return { name, days: parseDays(o.days, `${ctx}.days`), start, end }
	if (hasDates) return { name, dates: parseDates(o.dates, `${ctx}.dates`), start, end }
	// Neither: window is active every day in the [start, end) window.
	return { name, days: ALL_DAYS, start, end }
}

function parseDays(raw: unknown, ctx: string): readonly Day[] {
	if (!Array.isArray(raw)) throw new Error(`${ctx}: must be an array`)
	const out: Day[] = []
	for (const [i, d] of raw.entries()) {
		if (typeof d !== 'string' || !ALL_DAYS.includes(d as Day)) {
			throw new Error(
				`${ctx}[${i}]: must be one of ${ALL_DAYS.join('|')}, got ${JSON.stringify(d)}`,
			)
		}
		out.push(d as Day)
	}
	return out
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
function parseDates(raw: unknown, ctx: string): readonly string[] {
	if (!Array.isArray(raw)) throw new Error(`${ctx}: must be an array`)
	const out: string[] = []
	for (const [i, d] of raw.entries()) {
		if (typeof d !== 'string' || !DATE_RE.test(d)) {
			throw new Error(`${ctx}[${i}]: must be YYYY-MM-DD, got ${JSON.stringify(d)}`)
		}
		const m = DATE_RE.exec(d)!
		const year = Number(m[1])
		const month = Number(m[2])
		const day = Number(m[3])
		if (month < 1 || month > 12 || day < 1 || day > 31) {
			throw new Error(`${ctx}[${i}]: invalid calendar date ${d}`)
		}
		// Normalize formatting (e.g. drop accidental leading whitespace).
		out.push(
			`${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
				.toString()
				.padStart(2, '0')}`,
		)
	}
	return out
}

function expectString(v: unknown, ctx: string): string {
	if (typeof v !== 'string' || v.length === 0) {
		throw new Error(`${ctx}: must be a non-empty string`)
	}
	return v
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
function expectTime(v: unknown, ctx: string, opts: { allow24?: boolean } = {}): string {
	if (typeof v === 'string' && opts.allow24 && v === DAY_END) return DAY_END
	if (typeof v !== 'string' || !TIME_RE.test(v)) {
		throw new Error(`${ctx}: must be HH:MM (00:00–23:59), got ${JSON.stringify(v)}`)
	}
	return v
}

function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz })
		return true
	} catch {
		return false
	}
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
 * Compute the next moment, strictly after `now`, at which `isNightAt`
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
		let endDate = wraps || endRollOver ? addLocalDays(date, 1, timezone) : date
		const endHour = endRollOver ? 0 : endH
		const endMinute = endRollOver ? 0 : endMm
		out.push(
			startEdge,
			localTimeToUtc(endDate.year, endDate.month, endDate.day, endHour, endMinute, timezone),
		)
	}

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

/**
 * Walk up from this module's location looking for the workspace root —
 * the `package.json` whose `name` is `night-family`. Returns its dir or
 * `null` if not found within 5 levels.
 */
export function findRepoRoot(): string | null {
	let dir = dirname(fileURLToPath(import.meta.url))
	for (let i = 0; i < 6; i++) {
		const pkg = resolve(dir, 'package.json')
		if (existsSync(pkg)) {
			try {
				const json = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }
				if (json.name === 'night-family') return dir
			} catch {
				// fall through and keep walking
			}
		}
		const parent = dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
	return null
}

/**
 * Plain-text YAML emitted by `init-schedule`. Mirrors `BUILT_IN_DEFAULT`
 * and is fully commented so users can edit confidently.
 */
export function defaultScheduleYaml(): string {
	return `# Night Family member schedule.
# Decides WHEN this member is willing to do \`implement\` tasks. The skill
# set itself is configured via SKILLS in .env.member; this file only
# gates the \`implement\` skill in time. Outside any window below, the
# member offers everything in SKILLS minus \`implement\`.
#
# Edit and restart the member to apply changes.

# IANA timezone for all the HH:MM times below.
timezone: ${BUILT_IN_DEFAULT.timezone}

# Time windows during which \`implement\` is offered. Active if any window
# matches. Each window has either \`days\` (weekdays) or \`dates\`
# (specific calendar dates). Both \`start\` and \`end\` are optional —
# omit them for an all-day window. \`start\` > \`end\` wraps past midnight.
nightWindows:
    # While humans sleep.
    - name: night
      start: '22:00'
      end: '08:00'

    # Weekday lunch — humans away from keyboard, OK to implement.
    - name: lunch
      days: [mon, tue, wed, thu, fri]
      start: '12:00'
      end: '13:00'

    # Example: a weekend or vacation block where you also want
    # implementation to run all day. Uncomment and edit:
    # - name: vacation
    #   dates: ['2026-07-15', '2026-07-16', '2026-07-17']
`
}
