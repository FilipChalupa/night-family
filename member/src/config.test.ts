import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const REQUIRED_ENV = [
	'HOUSEHOLD_URL',
	'HOUSEHOLD_ACCESS_TOKEN',
	'AI_PROVIDER',
	'AI_MODEL',
	'AI_API_KEY',
] as const

const OPTIONAL_ENV = [
	'WORKSPACE_DIR',
	'MEMBER_NAME',
	'MEMBER_SKILLS',
	'WORKER_PROFILE',
	'MAX_TOKENS_PER_TASK',
	'MAX_TOKENS_PER_DAY',
	'MAX_TASK_DURATION_MINUTES',
	'LOG_LEVEL',
] as const

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
		// Sensible defaults for the happy path; tests override individual values.
		process.env.HOUSEHOLD_URL = 'http://localhost:8080'
		process.env.HOUSEHOLD_ACCESS_TOKEN = 'token-abc'
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

	it('loads a minimal happy-path config', () => {
		const cfg = loadConfig()
		expect(cfg.householdUrl).toBe('http://localhost:8080')
		expect(cfg.householdAccessToken).toBe('token-abc')
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

	it.each(REQUIRED_ENV)('throws when required env %s is missing', (key) => {
		delete process.env[key]
		expect(() => loadConfig()).toThrow(new RegExp(`Missing required env var: ${key}`))
	})

	it.each(['anthropic', 'gemini', 'openai'])('accepts AI_PROVIDER=%s', (p) => {
		process.env.AI_PROVIDER = p
		expect(loadConfig().provider).toBe(p)
	})

	it('rejects unknown AI_PROVIDER', () => {
		process.env.AI_PROVIDER = 'cohere'
		expect(() => loadConfig()).toThrow(/AI_PROVIDER must be/)
	})

	it.each(['hard', 'medium', 'lazy'])('accepts WORKER_PROFILE=%s', (p) => {
		process.env.WORKER_PROFILE = p
		expect(loadConfig().workerProfile).toBe(p)
	})

	it('rejects unknown WORKER_PROFILE', () => {
		process.env.WORKER_PROFILE = 'turbo'
		expect(() => loadConfig()).toThrow(/WORKER_PROFILE must be/)
	})

	it('parses MEMBER_SKILLS, trimming whitespace and dropping empties', () => {
		process.env.MEMBER_SKILLS = ' implement , review ,, '
		expect(loadConfig().skills).toEqual(['implement', 'review'])
	})

	it('rejects an unknown skill (typo guard)', () => {
		process.env.MEMBER_SKILLS = 'implement,implemnt'
		expect(() => loadConfig()).toThrow(/Unknown skill in MEMBER_SKILLS: implemnt/)
	})

	it('parses numeric limits and falls back when missing or unparseable', () => {
		process.env.MAX_TOKENS_PER_TASK = '5000'
		process.env.MAX_TOKENS_PER_DAY = 'not-a-number'
		process.env.MAX_TASK_DURATION_MINUTES = '30'
		const cfg = loadConfig()
		expect(cfg.limits.maxTokensPerTask).toBe(5000)
		expect(cfg.limits.maxTokensPerDay).toBeNull()
		expect(cfg.limits.maxTaskDurationMinutes).toBe(30)
	})

	it('resolves a relative WORKSPACE_DIR to an absolute path', () => {
		process.env.WORKSPACE_DIR = './relative-workspace'
		const cfg = loadConfig()
		expect(cfg.workspaceDir.startsWith('/')).toBe(true)
		expect(cfg.workspaceDir.endsWith('relative-workspace')).toBe(true)
	})

	it('persists member id across calls (load-or-create)', () => {
		const a = loadConfig().memberId
		const b = loadConfig().memberId
		expect(a).toBe(b)
		expect(a).toMatch(/^[0-9a-f-]{36}$/)
	})

	it('honors a custom MEMBER_NAME', () => {
		process.env.MEMBER_NAME = 'custom-name'
		expect(loadConfig().memberName).toBe('custom-name')
	})

	it('falls back to a default MEMBER_NAME when unset', () => {
		const cfg = loadConfig()
		expect(cfg.memberName.length).toBeGreaterThan(0)
	})
})
