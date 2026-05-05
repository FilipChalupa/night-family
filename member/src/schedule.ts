import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { Day, NightWindow, Schedule } from '@night/shared'

/**
 * Per-Member schedule loader. Reads a YAML file from disk (or returns a
 * built-in default), validates it, and hands the parsed {@link Schedule}
 * to the connection layer, which sends it to Household at handshake.
 *
 * The Member does not evaluate the schedule itself anymore; Household
 * decides "is this Member willing to take an `implement` task right
 * now?" using the schedule attached to its session. Member-side, this
 * file is purely about reading and validating YAML.
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

const ALL_DAYS: readonly Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

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
# member offers everything in SKILLS minus \`implement\`. Household
# evaluates this schedule per session — Members just ship the YAML.
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
