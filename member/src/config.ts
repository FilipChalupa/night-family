import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
	ALL_SKILLS,
	type Provider,
	type Schedule,
	type Skill,
	type WorkerProfile,
} from '@night/shared'
import { resolveSchedule } from './schedule.ts'

/**
 * Bootstrap-time snapshot of everything the Member needs to run. Treated as
 * immutable after {@link loadConfig} returns — runtime-mutable state lives on
 * the consumer (e.g. `HouseholdConnection.currentRepos` mirrors the initial
 * `repos` and refreshes in place without touching this object). Marking the
 * whole shape `readonly` keeps that invariant compiler-enforced.
 */
export interface MemberConfig {
	readonly householdUrl: string
	readonly householdAccessToken: string
	readonly memberId: string
	readonly memberName: string
	readonly displayName: string
	readonly githubPat: string
	/**
	 * Full skill set this Member is configured to do (from `SKILLS` env;
	 * default = all). The schedule below decides *when* `implement` is
	 * actually offered; other skills always pass through.
	 */
	readonly skills: readonly Skill[]
	/**
	 * Time-based gating for the `implement` skill. Inside any
	 * `nightWindow`, the Member offers everything in `skills`; outside,
	 * `implement` is dropped and the rest pass through. Loaded via
	 * `SCHEDULE_FILE` env / Docker conventional path / repo-root fallback,
	 * or built-in default if none of those exist.
	 */
	readonly schedule: Schedule
	/** Path of the YAML source, or `null` for built-in default. */
	readonly scheduleSource: string | null
	/**
	 * Repos this Member can work on, derived from `GET /user/repos` with
	 * the configured PAT. Empty = PAT has no repo access (Member can
	 * still handle non-repo tasks like `summarize`). Re-fetched at runtime
	 * via `repos.refresh`; the live mirror lives on `HouseholdConnection`,
	 * not here — this field stays at its boot-time value for the life of
	 * the process.
	 */
	readonly repos: readonly string[]
	readonly provider: Provider
	readonly model: string
	readonly aiApiKey: string
	readonly workerProfile: WorkerProfile
	readonly workspaceDir: string
	readonly limits: {
		readonly maxTokensPerTask: number | null
		readonly maxTokensPerDay: number | null
		readonly maxTaskDurationMinutes: number
	}
	/** Settings for the `preview` skill (runs a project's dev server). */
	readonly preview: {
		/**
		 * Ports the preview exposes, in priority order — the first is the
		 * primary (the dev server we inject `PORT` into and wait for). Extra
		 * ports (e.g. a separate API) are advertised as additional links but
		 * not health-checked. Always at least one entry.
		 */
		readonly ports: ReadonlyArray<{ readonly port: number; readonly label: string }>
		readonly readyTimeoutMs: number
		/**
		 * How a running preview is exposed:
		 *   - `local`: report the Member-local `http://localhost:<port>` URL.
		 *   - `household`: report a stable `<household>/previews/<task>` URL the
		 *     Household redirects to the live server.
		 *   - `subdomain`: report `https://p<port>-<task>.<domain>`; the Household
		 *     proxies it to the live server over the Member's preview tunnel.
		 *     Requires `domain` (`PREVIEWS_DOMAIN`); falls back to `local` without.
		 */
		readonly publishMode: 'local' | 'household' | 'subdomain'
		/** Preview subdomain base (`PREVIEWS_DOMAIN`), or null. */
		readonly domain: string | null
	}
	readonly logLevel: string
}

function required(name: string): string {
	const v = process.env[name]
	if (!v) {
		throw new Error(`Missing required env var: ${name}`)
	}
	return v
}

function optional(name: string, fallback: string): string {
	return process.env[name] ?? fallback
}

function optionalNumber(name: string): number | null {
	const v = process.env[name]
	if (!v) return null
	const n = Number.parseInt(v, 10)
	if (!Number.isFinite(n)) return null
	return n
}

function parseSkills(raw: string): Skill[] {
	const parts = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean) as Skill[]
	for (const p of parts) {
		if (!ALL_SKILLS.includes(p)) {
			throw new Error(`Unknown skill in SKILLS: ${p}`)
		}
	}
	return parts
}

function parseProvider(raw: string): Provider {
	if (raw !== 'anthropic' && raw !== 'gemini' && raw !== 'openai') {
		throw new Error(`AI_PROVIDER must be anthropic|gemini|openai, got: ${raw}`)
	}
	return raw
}

/**
 * Parse `PREVIEW_PORTS` — a comma-separated `port[:label]` list, e.g.
 * `5173:web,3000:api`. The first entry is the primary. Falls back to a single
 * `basePort` (label `app`) when the env is unset/empty. Throws on a malformed
 * entry so a typo fails loudly at startup rather than silently dropping a port.
 */
export function parsePreviewPorts(
	raw: string | undefined,
	basePort: number,
): Array<{ port: number; label: string }> {
	if (!raw || raw.trim() === '') return [{ port: basePort, label: 'app' }]
	const out = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((entry) => {
			const [portRaw, labelRaw] = entry.split(':')
			const port = Number.parseInt(portRaw!, 10)
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				throw new Error(`Invalid port in PREVIEW_PORTS: ${entry}`)
			}
			const label = labelRaw?.trim() || String(port)
			return { port, label }
		})
	if (out.length === 0) return [{ port: basePort, label: 'app' }]
	return out
}

function parsePreviewPublishMode(raw: string): 'local' | 'household' | 'subdomain' {
	if (raw !== 'local' && raw !== 'household' && raw !== 'subdomain') {
		throw new Error(`PREVIEW_PUBLISH_MODE must be local|household|subdomain, got: ${raw}`)
	}
	return raw
}

function parseProfile(raw: string): WorkerProfile {
	if (raw !== 'hard' && raw !== 'medium' && raw !== 'lazy') {
		throw new Error(`WORKER_PROFILE must be hard|medium|lazy, got: ${raw}`)
	}
	return raw
}

function loadOrCreateMemberId(workspaceDir: string): string {
	const path = join(workspaceDir, '.member-id')
	if (existsSync(path)) {
		const v = readFileSync(path, 'utf8').trim()
		if (v) return v
	}
	const id = randomUUID()
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, id, 'utf8')
	return id
}

export interface GithubIdentity {
	login: string
	displayName: string
	repos: string[]
}

const GH_API = 'https://api.github.com'
const GH_HEADERS = (pat: string) => ({
	authorization: `Bearer ${pat}`,
	accept: 'application/vnd.github+json',
	'x-github-api-version': '2022-11-28',
})

export async function fetchGithubIdentity(pat: string): Promise<GithubIdentity> {
	const res = await fetch(`${GH_API}/user`, { headers: GH_HEADERS(pat) })
	if (!res.ok) {
		const body = await res.text().catch(() => '')
		throw new Error(
			`GITHUB_PAT rejected by GitHub (${res.status}): ${body.slice(0, 200) || res.statusText}`,
		)
	}
	const json = (await res.json()) as { login?: unknown; name?: unknown }
	const login = typeof json.login === 'string' ? json.login : null
	if (!login) {
		throw new Error('GitHub /user response did not include a `login` field')
	}
	const name = typeof json.name === 'string' && json.name.length > 0 ? json.name : login
	const repos = await fetchAccessibleRepos(pat)
	return { login, displayName: name, repos }
}

/**
 * Enumerate every repo this PAT can write to, via paginated `/user/repos`.
 * `/user/repos` returns repos the *user* can reach — for classic PATs that
 * includes public org repos the user is only a read-only member of, which
 * the PAT can't push to. Filter by `permissions.push` so the allowlist
 * matches what the Member can actually do work on.
 *
 * Note: `permissions` here reflects the *user's* role, not the token's
 * effective scopes. A fine-grained PAT scoped to `Contents: Read` on a
 * repo the user owns will still come back as pushable. The Repos panel
 * surfaces this list as suggestions only; the actual push attempt at
 * task time is the final source of truth.
 */
/**
 * Per-request deadline for one page of `/user/repos`. A hung TCP / stuck
 * proxy / paused GitHub edge would otherwise leave the caller's
 * `refreshingRepos` promise pending forever — coalescing would silently
 * swallow every subsequent refresh request.
 */
const GH_REPOS_REQUEST_TIMEOUT_MS = 30_000

export async function fetchAccessibleRepos(pat: string): Promise<string[]> {
	const PER_PAGE = 100
	const MAX_PAGES = 10 // 1000 repos cap; way past realistic Night Family setups
	const all: string[] = []
	for (let page = 1; page <= MAX_PAGES; page++) {
		const url = `${GH_API}/user/repos?per_page=${PER_PAGE}&page=${page}&affiliation=owner,collaborator,organization_member`
		const ac = new AbortController()
		const timer = setTimeout(() => ac.abort(), GH_REPOS_REQUEST_TIMEOUT_MS)
		let res: Response
		try {
			res = await fetch(url, { headers: GH_HEADERS(pat), signal: ac.signal })
		} catch (err) {
			if (ac.signal.aborted) {
				throw new Error(
					`GitHub /user/repos timed out after ${GH_REPOS_REQUEST_TIMEOUT_MS} ms`,
				)
			}
			throw err
		} finally {
			clearTimeout(timer)
		}
		if (!res.ok) {
			const body = await res.text().catch(() => '')
			throw new Error(
				`GitHub /user/repos failed (${res.status}): ${body.slice(0, 200) || res.statusText}`,
			)
		}
		const items = (await res.json()) as Array<{
			full_name?: unknown
			permissions?: { push?: unknown; admin?: unknown }
		}>
		for (const r of items) {
			if (typeof r.full_name !== 'string') continue
			const canWrite = r.permissions?.push === true || r.permissions?.admin === true
			if (canWrite) all.push(r.full_name)
		}
		if (items.length < PER_PAGE) break
	}
	return all
}

interface PartialConfig extends Omit<MemberConfig, 'memberName' | 'displayName' | 'repos'> {}

function loadEnvConfig(): PartialConfig {
	const workspaceDirRaw = optional('WORKSPACE_DIR', '/workspace')
	const workspaceDir = isAbsolute(workspaceDirRaw) ? workspaceDirRaw : resolve(workspaceDirRaw)
	const skillsRawEnv = process.env.SKILLS
	const skills =
		skillsRawEnv !== undefined && skillsRawEnv !== ''
			? parseSkills(skillsRawEnv)
			: [...ALL_SKILLS]
	const resolved = resolveSchedule()

	return {
		householdUrl: required('HOUSEHOLD_URL'),
		householdAccessToken: required('HOUSEHOLD_ACCESS_TOKEN'),
		memberId: loadOrCreateMemberId(workspaceDir),
		githubPat: required('GITHUB_PAT'),
		skills,
		schedule: resolved.schedule,
		scheduleSource: resolved.source,
		provider: parseProvider(required('AI_PROVIDER')),
		model: required('AI_MODEL'),
		aiApiKey: required('AI_API_KEY'),
		workerProfile: parseProfile(optional('WORKER_PROFILE', 'medium')),
		workspaceDir,
		limits: {
			maxTokensPerTask: optionalNumber('MAX_TOKENS_PER_TASK'),
			maxTokensPerDay: optionalNumber('MAX_TOKENS_PER_DAY'),
			maxTaskDurationMinutes: optionalNumber('MAX_TASK_DURATION_MINUTES') ?? 120,
		},
		preview: {
			ports: parsePreviewPorts(
				process.env.PREVIEW_PORTS,
				optionalNumber('PREVIEW_BASE_PORT') ?? 4321,
			),
			readyTimeoutMs: optionalNumber('PREVIEW_READY_TIMEOUT_MS') ?? 120_000,
			publishMode: parsePreviewPublishMode(optional('PREVIEW_PUBLISH_MODE', 'local')),
			domain: process.env.PREVIEWS_DOMAIN?.trim() || null,
		},
		logLevel: optional('LOG_LEVEL', 'info'),
	}
}

export async function loadConfig(
	resolveIdentity: (pat: string) => Promise<GithubIdentity> = fetchGithubIdentity,
): Promise<MemberConfig> {
	const partial = loadEnvConfig()
	const identity = await resolveIdentity(partial.githubPat)
	return {
		...partial,
		memberName: identity.login,
		displayName: identity.displayName,
		repos: identity.repos,
	}
}
