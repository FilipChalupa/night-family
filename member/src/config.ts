import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ALL_SKILLS, type Provider, type Skill, type WorkerProfile } from '@night/shared'

export interface MemberConfig {
	householdUrl: string
	householdAccessToken: string
	memberId: string
	memberName: string
	skills: Skill[]
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
			throw new Error(`Unknown skill in MEMBER_SKILLS: ${p}`)
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

/**
 * Load (or generate) a persistent member_id from <workspace>/.member-id.
 * Reset of the workspace volume = new id = Household sees a fresh Member.
 */
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

function defaultMemberName(): string {
	try {
		return userInfo().username + '@' + hostname()
	} catch {
		return hostname()
	}
}

export function loadConfig(): MemberConfig {
	const workspaceDirRaw = optional('WORKSPACE_DIR', '/workspace')
	// Always store an absolute path: Workspace.create runs `git` with overridden
	// cwd, and a relative `workspaceDir` would land the bare clone in the wrong
	// place (resolved relative to git's cwd, not the process cwd).
	const workspaceDir = isAbsolute(workspaceDirRaw) ? workspaceDirRaw : resolve(workspaceDirRaw)
	const skillsRaw = optional('MEMBER_SKILLS', ALL_SKILLS.join(','))

	return {
		householdUrl: required('HOUSEHOLD_URL'),
		householdAccessToken: required('HOUSEHOLD_ACCESS_TOKEN'),
		memberId: loadOrCreateMemberId(workspaceDir),
		memberName: optional('MEMBER_NAME', defaultMemberName()),
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
