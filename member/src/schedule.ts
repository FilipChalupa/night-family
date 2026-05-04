import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { ALL_SKILLS, type Skill } from '@night/shared'

/**
 * Per-Member schedule that decides which skills the Member offers right
 * now. Everything here is pure (no clocks, no timers, no I/O) so it can
 * be exhaustively tested. Connection wiring lives in `connection.ts`.
 *
 * Lookup chain for the YAML source (first hit wins):
 *
 *   1. `SCHEDULE_FILE` env var — explicit override, dev or prod.
 *   2. `/etc/night-family/schedule.yaml` — Docker bind-mount convention.
 *   3. `<repo-root>/schedule.yaml` — convenience for `npm run dev`.
 *
 * Nothing found = built-in default (defined below). Never throws on
 * missing file; only on malformed YAML or invalid shape.
 */

export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
const ALL_DAYS: readonly Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export interface ScheduleWindow {
	name: string
	/** Days on which the window's *start* falls. Default = every day. */
	days: readonly Day[]
	/** Local-time `HH:MM` of window start. */
	start: string
	/** Local-time `HH:MM` of window end. If `<= start`, the window wraps midnight. */
	end: string
	skills: readonly Skill[]
}

export interface Schedule {
	/** IANA timezone identifier (e.g. `Europe/Prague`). */
	timezone: string
	/** Skills used outside any active window. */
	baseline: readonly Skill[]
	windows: readonly ScheduleWindow[]
}

export interface ScheduleEvaluation {
	skills: readonly Skill[]
	/** Name of the active window, or `'baseline'` when none matches. */
	activeName: string
}

const FIXED_DOCKER_PATH = '/etc/night-family/schedule.yaml'
const DEFAULT_FILENAME = 'schedule.yaml'

const BUILT_IN_DEFAULT: Schedule = {
	timezone: process.env.TZ || 'UTC',
	baseline: ['review', 'estimate', 'respond', 'summarize'],
	windows: [
		{
			name: 'night',
			days: ALL_DAYS,
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

export interface ResolveScheduleResult {
	schedule: Schedule
	/** Absolute path of the source, or `null` for built-in default. */
	source: string | null
}

/**
 * Resolve and parse the active schedule for this Member. See lookup
 * chain in the file header. Pass `envSchedulePath` to override the env
 * lookup in tests.
 */
export function resolveSchedule(
	envSchedulePath: string | undefined = process.env.SCHEDULE_FILE,
): ResolveScheduleResult {
	const candidates: string[] = []
	if (envSchedulePath) {
		candidates.push(isAbsolute(envSchedulePath) ? envSchedulePath : resolve(envSchedulePath))
	}
	candidates.push(FIXED_DOCKER_PATH)
	const repoRoot = findRepoRoot()
	if (repoRoot) candidates.push(resolve(repoRoot, DEFAULT_FILENAME))
	for (const path of candidates) {
		if (!existsSync(path)) continue
		const raw = readFileSync(path, 'utf8')
		return { schedule: parseSchedule(raw), source: path }
	}
	return { schedule: BUILT_IN_DEFAULT, source: null }
}

/**
 * Parse and validate a schedule YAML document. Throws on shape errors
 * with a message that points at the offending field.
 */
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
	const baseline = expectSkills(o.baseline, 'baseline')
	const windowsRaw = o.windows
	if (windowsRaw !== undefined && !Array.isArray(windowsRaw)) {
		throw new Error('schedule.windows: must be an array')
	}
	const windows: ScheduleWindow[] = []
	for (const [i, raw] of (windowsRaw ?? []).entries()) {
		windows.push(parseWindow(raw, `windows[${i}]`))
	}
	return { timezone, baseline, windows }
}

function parseWindow(raw: unknown, ctx: string): ScheduleWindow {
	if (!raw || typeof raw !== 'object') throw new Error(`${ctx}: must be an object`)
	const o = raw as Record<string, unknown>
	const name = expectString(o.name, `${ctx}.name`)
	const start = expectTime(o.start, `${ctx}.start`)
	const end = expectTime(o.end, `${ctx}.end`)
	const skills = expectSkills(o.skills, `${ctx}.skills`)
	const days = parseDays(o.days, `${ctx}.days`)
	return { name, days, start, end, skills }
}

function parseDays(raw: unknown, ctx: string): readonly Day[] {
	if (raw === undefined) return ALL_DAYS
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

function expectString(v: unknown, ctx: string): string {
	if (typeof v !== 'string' || v.length === 0) {
		throw new Error(`${ctx}: must be a non-empty string`)
	}
	return v
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
function expectTime(v: unknown, ctx: string): string {
	if (typeof v !== 'string' || !TIME_RE.test(v)) {
		throw new Error(`${ctx}: must be HH:MM (00:00–23:59), got ${JSON.stringify(v)}`)
	}
	return v
}

function expectSkills(raw: unknown, ctx: string): readonly Skill[] {
	if (!Array.isArray(raw)) throw new Error(`${ctx}: must be an array`)
	const out: Skill[] = []
	for (const [i, s] of raw.entries()) {
		if (typeof s !== 'string' || !ALL_SKILLS.includes(s as Skill)) {
			throw new Error(
				`${ctx}[${i}]: must be one of ${ALL_SKILLS.join('|')}, got ${JSON.stringify(s)}`,
			)
		}
		out.push(s as Skill)
	}
	return out
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
 * Decide which skills are active at a given moment under a schedule.
 * Windows are evaluated in declaration order; the *last* one whose span
 * contains `now` wins, so generic windows can be put first and exceptions
 * last (e.g. `night`, then `lunch`). When no window matches, returns
 * `baseline`.
 */
export function evaluateSchedule(schedule: Schedule, now: Date): ScheduleEvaluation {
	let match: ScheduleWindow | null = null
	for (const w of schedule.windows) {
		if (windowContains(w, now, schedule.timezone)) match = w
	}
	if (match) return { skills: match.skills, activeName: match.name }
	return { skills: schedule.baseline, activeName: 'baseline' }
}

/**
 * Compute the next moment, strictly after `now`, at which `evaluateSchedule`
 * could produce a different result. Bound by 7 days into the future (full
 * week cycle), which means the worst case keeps the timer fresh weekly even
 * if no transitions exist.
 */
export function nextTransition(schedule: Schedule, now: Date): Date {
	const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
	let earliest: Date | null = null
	for (const w of schedule.windows) {
		for (const d of w.days) {
			for (const edge of windowEdges(w, d, schedule.timezone, now)) {
				if (edge.getTime() <= now.getTime()) continue
				if (edge.getTime() > horizon.getTime()) continue
				if (!earliest || edge.getTime() < earliest.getTime()) earliest = edge
			}
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

const WEEKDAY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>()
function localFormatter(timezone: string): Intl.DateTimeFormat {
	let f = WEEKDAY_FORMATTER_CACHE.get(timezone)
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
		WEEKDAY_FORMATTER_CACHE.set(timezone, f)
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
	// Some Intl backends emit `24:xx` for midnight in `hour12: false`; normalize.
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

function parseHHMM(t: string): { h: number; m: number } {
	const [h, m] = t.split(':')
	return { h: Number(h), m: Number(m) }
}

/**
 * Project a local-time `HH:MM` on a given date into a UTC `Date` for the
 * schedule's timezone. Iterates a small offset search to invert
 * `Intl.DateTimeFormat`, since DST means a naïve UTC subtraction is off
 * twice a year.
 */
function localTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timezone: string,
): Date {
	// First pass: assume UTC, then iteratively correct using observed offset.
	let guess = Date.UTC(year, month - 1, day, hour, minute)
	for (let i = 0; i < 3; i++) {
		const parts = localParts(new Date(guess), timezone)
		const driftMin =
			(parts.year - year) * 525_600 +
			(parts.month - month) * 43_200 +
			(parts.day - day) * 1_440 +
			(parts.hour - hour) * 60 +
			(parts.minute - minute)
		if (driftMin === 0) return new Date(guess)
		guess -= driftMin * 60_000
	}
	return new Date(guess)
}

function windowContains(w: ScheduleWindow, now: Date, timezone: string): boolean {
	const np = localParts(now, timezone)
	const start = parseHHMM(w.start)
	const end = parseHHMM(w.end)
	const startMin = start.h * 60 + start.m
	const endMin = end.h * 60 + end.m
	const nowMin = np.hour * 60 + np.minute
	if (startMin < endMin) {
		// Same-day window: the window's day-of-week is the local day-of-week now.
		if (!w.days.includes(np.weekday)) return false
		return nowMin >= startMin && nowMin < endMin
	}
	// Wrap-midnight window: started either today or yesterday.
	if (nowMin >= startMin) {
		return w.days.includes(np.weekday)
	}
	if (nowMin < endMin) {
		return w.days.includes(prevDay(np.weekday))
	}
	return false
}

function prevDay(d: Day): Day {
	const idx = ALL_DAYS.indexOf(d)
	return ALL_DAYS[(idx + ALL_DAYS.length - 1) % ALL_DAYS.length]!
}

/**
 * Emit start+end edge timestamps for every occurrence of `(window, startDay)`
 * within roughly a week-wide window centered on `now`. The caller drops
 * past edges. Probing weekOffsets `[-1, 0, +1]` covers the wrap-midnight
 * case where the *end* is in the future even though the *start* was last
 * week.
 */
function windowEdges(w: ScheduleWindow, startDay: Day, timezone: string, now: Date): Date[] {
	const np = localParts(now, timezone)
	const start = parseHHMM(w.start)
	const end = parseHHMM(w.end)
	const wraps = end.h * 60 + end.m <= start.h * 60 + start.m
	const todayIdx = ALL_DAYS.indexOf(np.weekday)
	const targetIdx = ALL_DAYS.indexOf(startDay)
	const baseDelta = (targetIdx - todayIdx + 7) % 7
	const out: Date[] = []
	for (const weekOffset of [-1, 0, 1]) {
		const delta = baseDelta + weekOffset * 7
		const startLocal = addLocalDays(np, delta, timezone)
		out.push(toUtc(startLocal, start.h, start.m, timezone))
		const endLocal = wraps ? addLocalDays(startLocal, 1, timezone) : startLocal
		out.push(toUtc(endLocal, end.h, end.m, timezone))
	}
	return out
}

function toUtc(
	p: { year: number; month: number; day: number },
	hour: number,
	minute: number,
	timezone: string,
): Date {
	return localTimeToUtc(p.year, p.month, p.day, hour, minute, timezone)
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
 * Walk up from this module's location looking for the workspace root —
 * the `package.json` whose `name` is `night-family`. Returns its dir or
 * `null` if not found within 5 levels.
 */
function findRepoRoot(): string | null {
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
# Decides which skills the member offers at any given moment.
# Edit and restart the member to apply changes.

# IANA timezone for all the HH:MM times below.
timezone: ${BUILT_IN_DEFAULT.timezone}

# Skills used outside any window — i.e. "daytime" by default. The member
# will only accept tasks whose kind is in this list.
baseline: [review, estimate, respond, summarize]

# Time windows that override the baseline. Evaluated in order; the LAST
# matching window wins, so put generic windows first and exceptions last.
windows:
    # Implement-heavy mode while humans sleep. \`start\` > \`end\` means it
    # wraps past midnight (here: 22:00 today through 08:00 tomorrow).
    - name: night
      start: '22:00'
      end: '08:00'
      skills: [implement, review, estimate, respond, summarize]

    # Lunch break — humans away from keyboard, OK to implement. \`days\`
    # restricts to weekdays. Listed AFTER \`night\`, so on the rare overlap
    # (none here) the lunch entry would win.
    - name: lunch
      days: [mon, tue, wed, thu, fri]
      start: '12:00'
      end: '13:00'
      skills: [implement]
`
}
