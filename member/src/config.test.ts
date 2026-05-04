import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchGithubIdentity, loadConfig, type GithubIdentity } from './config.ts'

const REQUIRED_ENV = [
	'HOUSEHOLD_URL',
	'HOUSEHOLD_ACCESS_TOKEN',
	'GITHUB_PAT',
	'AI_PROVIDER',
	'AI_MODEL',
	'AI_API_KEY',
] as const

const OPTIONAL_ENV = [
	'WORKSPACE_DIR',
	'SKILLS',
	'WORKER_PROFILE',
	'MAX_TOKENS_PER_TASK',
	'MAX_TOKENS_PER_DAY',
	'MAX_TASK_DURATION_MINUTES',
	'LOG_LEVEL',
] as const

const stubIdentity = async (_pat: string): Promise<GithubIdentity> => ({
	login: 'stubuser',
	displayName: 'Stub User',
	repos: ['acme/foo', 'acme/bar'],
})

describe('loadConfig', () => {
	let workspace: string
	let snapshot: Record<string, string | undefined>

	beforeEach(async () => {
		workspace = await mkdtemp(join(tmpdir(), 'mcfg-'))
		snapshot = {}
		for (const k of [...REQUIRED_ENV, ...OPTIONAL_ENV]) {
			snapshot[k] = process.env[k]
			delete process.env[k]
		}
		process.env.HOUSEHOLD_URL = 'http://localhost:8080'
		process.env.HOUSEHOLD_ACCESS_TOKEN = 'token-abc'
		process.env.GITHUB_PAT = 'ghp_test'
		process.env.AI_PROVIDER = 'anthropic'
		process.env.AI_MODEL = 'claude-opus-4-7'
		process.env.AI_API_KEY = 'fake'
		process.env.WORKSPACE_DIR = workspace
	})

	afterEach(async () => {
		for (const k of [...REQUIRED_ENV, ...OPTIONAL_ENV]) {
			if (snapshot[k] === undefined) delete process.env[k]
			else process.env[k] = snapshot[k]
		}
		await rm(workspace, { recursive: true, force: true })
	})

	it('loads a minimal happy-path config', async () => {
		const cfg = await loadConfig(stubIdentity)
		expect(cfg.householdUrl).toBe('http://localhost:8080')
		expect(cfg.householdAccessToken).toBe('token-abc')
		expect(cfg.githubPat).toBe('ghp_test')
		expect(cfg.memberName).toBe('stubuser')
		expect(cfg.displayName).toBe('Stub User')
		expect(cfg.repos).toEqual(['acme/foo', 'acme/bar'])
		expect(cfg.provider).toBe('anthropic')
		expect(cfg.model).toBe('claude-opus-4-7')
		expect(cfg.aiApiKey).toBe('fake')
		expect(cfg.workspaceDir).toBe(workspace)
		expect(cfg.workerProfile).toBe('medium')
		expect(cfg.logLevel).toBe('info')
		expect(cfg.limits.maxTaskDurationMinutes).toBe(120)
		expect(cfg.limits.maxTokensPerTask).toBeNull()
		expect(cfg.limits.maxTokensPerDay).toBeNull()
		expect(cfg.skills).toEqual(['implement', 'review', 'estimate', 'respond', 'summarize'])
	})

	it.each(REQUIRED_ENV)('throws when required env %s is missing', async (key) => {
		delete process.env[key]
		await expect(loadConfig(stubIdentity)).rejects.toThrow(
			new RegExp(`Missing required env var: ${key}`),
		)
	})

	it.each(['anthropic', 'gemini', 'openai'])('accepts AI_PROVIDER=%s', async (p) => {
		process.env.AI_PROVIDER = p
		const cfg = await loadConfig(stubIdentity)
		expect(cfg.provider).toBe(p)
	})

	it('rejects unknown AI_PROVIDER', async () => {
		process.env.AI_PROVIDER = 'cohere'
		await expect(loadConfig(stubIdentity)).rejects.toThrow(/AI_PROVIDER must be/)
	})

	it.each(['hard', 'medium', 'lazy'])('accepts WORKER_PROFILE=%s', async (p) => {
		process.env.WORKER_PROFILE = p
		const cfg = await loadConfig(stubIdentity)
		expect(cfg.workerProfile).toBe(p)
	})

	it('rejects unknown WORKER_PROFILE', async () => {
		process.env.WORKER_PROFILE = 'turbo'
		await expect(loadConfig(stubIdentity)).rejects.toThrow(/WORKER_PROFILE must be/)
	})

	it('parses SKILLS, trimming whitespace and dropping empties', async () => {
		process.env.SKILLS = ' implement , review ,, '
		const cfg = await loadConfig(stubIdentity)
		expect(cfg.skills).toEqual(['implement', 'review'])
	})

	it('rejects an unknown skill (typo guard)', async () => {
		process.env.SKILLS = 'implement,implemnt'
		await expect(loadConfig(stubIdentity)).rejects.toThrow(/Unknown skill in SKILLS: implemnt/)
	})

	it('parses numeric limits and falls back when missing or unparseable', async () => {
		process.env.MAX_TOKENS_PER_TASK = '5000'
		process.env.MAX_TOKENS_PER_DAY = 'not-a-number'
		process.env.MAX_TASK_DURATION_MINUTES = '30'
		const cfg = await loadConfig(stubIdentity)
		expect(cfg.limits.maxTokensPerTask).toBe(5000)
		expect(cfg.limits.maxTokensPerDay).toBeNull()
		expect(cfg.limits.maxTaskDurationMinutes).toBe(30)
	})

	it('resolves a relative WORKSPACE_DIR to an absolute path', async () => {
		process.env.WORKSPACE_DIR = './relative-workspace'
		const cfg = await loadConfig(stubIdentity)
		expect(cfg.workspaceDir.startsWith('/')).toBe(true)
		expect(cfg.workspaceDir.endsWith('relative-workspace')).toBe(true)
	})

	it('persists member id across calls (load-or-create)', async () => {
		const a = (await loadConfig(stubIdentity)).memberId
		const b = (await loadConfig(stubIdentity)).memberId
		expect(a).toBe(b)
		expect(a).toMatch(/^[0-9a-f-]{36}$/)
	})

	it('uses display name fallback to login when GitHub returns no name', async () => {
		const cfg = await loadConfig(async () => ({
			login: 'noname',
			displayName: 'noname',
			repos: [],
		}))
		expect(cfg.memberName).toBe('noname')
		expect(cfg.displayName).toBe('noname')
		expect(cfg.repos).toEqual([])
	})

	it('propagates an identity-fetch failure', async () => {
		const fail = async (): Promise<GithubIdentity> => {
			throw new Error('GITHUB_PAT rejected by GitHub (401): Bad credentials')
		}
		await expect(loadConfig(fail)).rejects.toThrow(/GITHUB_PAT rejected by GitHub/)
	})
})

describe('fetchGithubIdentity', () => {
	const userResponse = { login: 'octo', name: 'Octo Cat' }

	function mockFetch(reposPage: unknown[]) {
		return vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.endsWith('/user')) {
				return new Response(JSON.stringify(userResponse), { status: 200 })
			}
			if (url.includes('/user/repos')) {
				return new Response(JSON.stringify(reposPage), { status: 200 })
			}
			throw new Error(`unexpected fetch: ${url}`)
		})
	}

	let originalFetch: typeof globalThis.fetch
	beforeEach(() => {
		originalFetch = globalThis.fetch
	})
	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it('keeps repos the PAT can push to', async () => {
		globalThis.fetch = mockFetch([
			{ full_name: 'octo/owned', permissions: { admin: true, push: true, pull: true } },
			{ full_name: 'octo/collab', permissions: { admin: false, push: true, pull: true } },
		]) as unknown as typeof globalThis.fetch
		const id = await fetchGithubIdentity('ghp_test')
		expect(id.repos).toEqual(['octo/owned', 'octo/collab'])
	})

	it('drops public org repos where the PAT only has read access', async () => {
		globalThis.fetch = mockFetch([
			{ full_name: 'octo/owned', permissions: { admin: true, push: true, pull: true } },
			{ full_name: 'public-org/readme', permissions: { admin: false, push: false, pull: true } },
		]) as unknown as typeof globalThis.fetch
		const id = await fetchGithubIdentity('ghp_test')
		expect(id.repos).toEqual(['octo/owned'])
	})

	it('treats missing permissions as no write access', async () => {
		globalThis.fetch = mockFetch([
			{ full_name: 'octo/no-perms' },
			{ full_name: 'octo/owned', permissions: { admin: true, push: true, pull: true } },
		]) as unknown as typeof globalThis.fetch
		const id = await fetchGithubIdentity('ghp_test')
		expect(id.repos).toEqual(['octo/owned'])
	})
})
