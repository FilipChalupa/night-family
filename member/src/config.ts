import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ALL_SKILLS, type Provider, type Skill, type WorkerProfile } from '@night/shared'

export interface MemberConfig {
	householdUrl: string
	householdAccessToken: string
	memberId: string
	memberName: string
	displayName: string
	githubPat: string
	skills: Skill[]
	/**
	 * Repos this Member can work on, derived from `GET /user/repos` with
	 * the configured PAT. Empty = PAT has no repo access (Member can
	 * still handle non-repo tasks like `summarize`).
	 */
	repos: string[]
	provider: Provider
	model: string
	aiApiKey: string
	workerProfile: WorkerProfile
	workspaceDir: string
	limits: {
		maxTokensPerTask: number | null
		maxTokensPerDay: number | null
		maxTaskDurationMinutes: number
	}
	logLevel: string
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
 */
async function fetchAccessibleRepos(pat: string): Promise<string[]> {
	const PER_PAGE = 100
	const MAX_PAGES = 10 // 1000 repos cap; way past realistic Night Family setups
	const all: string[] = []
	for (let page = 1; page <= MAX_PAGES; page++) {
		const url = `${GH_API}/user/repos?per_page=${PER_PAGE}&page=${page}&affiliation=owner,collaborator,organization_member`
		const res = await fetch(url, { headers: GH_HEADERS(pat) })
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
	const skillsRaw = optional('SKILLS', ALL_SKILLS.join(','))

	return {
		householdUrl: required('HOUSEHOLD_URL'),
		householdAccessToken: required('HOUSEHOLD_ACCESS_TOKEN'),
		memberId: loadOrCreateMemberId(workspaceDir),
		githubPat: required('GITHUB_PAT'),
		skills: parseSkills(skillsRaw),
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
