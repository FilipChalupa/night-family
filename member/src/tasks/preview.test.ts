import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { Logger } from 'pino'
import {
	detectInstallCommand,
	detectStartCommand,
	normalizeUrl,
	PreviewServer,
	probePort,
	upsertPreviewSection,
} from './preview.ts'

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	child: () => silentLogger,
} as unknown as Logger

const START = '<!-- night-preview:start -->'
const END = '<!-- night-preview:end -->'
const section = (body: string) => `${START}\n${body}\n${END}`

describe('detectStartCommand', () => {
	it('prefers dev over preview over start', () => {
		expect(detectStartCommand({ scripts: { dev: 'x', preview: 'y', start: 'z' } })).toBe(
			'npm run dev',
		)
		expect(detectStartCommand({ scripts: { preview: 'y', start: 'z' } })).toBe(
			'npm run preview',
		)
		expect(detectStartCommand({ scripts: { start: 'z' } })).toBe('npm run start')
	})

	it('returns null when no runnable script exists', () => {
		expect(detectStartCommand({ scripts: { build: 'x', test: 'y' } })).toBeNull()
		expect(detectStartCommand({})).toBeNull()
	})
})

describe('detectInstallCommand', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'night-preview-test-'))
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	const touch = (name: string) => writeFileSync(join(dir, name), '')

	it('maps each lockfile to its install command, pnpm > yarn > npm-ci', () => {
		touch('package.json')
		touch('package-lock.json')
		expect(detectInstallCommand(dir)).toBe('npm ci')
		touch('yarn.lock')
		expect(detectInstallCommand(dir)).toBe('yarn install --frozen-lockfile')
		touch('pnpm-lock.yaml')
		expect(detectInstallCommand(dir)).toBe('pnpm install --frozen-lockfile')
	})

	it('falls back to npm install with a package.json but no lockfile', () => {
		touch('package.json')
		expect(detectInstallCommand(dir)).toBe('npm install')
	})

	it('returns null when there is nothing to install', () => {
		expect(detectInstallCommand(dir)).toBeNull()
	})
})

describe('normalizeUrl', () => {
	it('rewrites wildcard hosts to localhost', () => {
		expect(normalizeUrl('http://0.0.0.0:5173', 5173)).toBe('http://localhost:5173')
		expect(normalizeUrl('http://[::]:3000/', 3000)).toBe('http://localhost:3000')
	})

	it('fills in the port when the URL omits it and strips a trailing slash', () => {
		expect(normalizeUrl('http://localhost/', 4321)).toBe('http://localhost:4321')
	})

	it('leaves a normal URL intact and returns unparseable input unchanged', () => {
		expect(normalizeUrl('http://localhost:5173', 5173)).toBe('http://localhost:5173')
		expect(normalizeUrl('not a url', 4321)).toBe('not a url')
	})
})

describe('upsertPreviewSection', () => {
	it('appends the section to a body that has none', () => {
		const out = upsertPreviewSection('## Summary\n\nhi', section('▶ Running'))
		expect(out).toContain('## Summary')
		expect(out).toContain(section('▶ Running'))
		expect(out.endsWith('\n')).toBe(true)
	})

	it('replaces an existing section in place rather than stacking (idempotent)', () => {
		const first = upsertPreviewSection('body', section('▶ Running'))
		const second = upsertPreviewSection(first, section('⏹ Stopped'))
		expect(second.match(new RegExp(START, 'g'))?.length).toBe(1)
		expect(second).toContain('⏹ Stopped')
		expect(second).not.toContain('▶ Running')
		expect(second).toContain('body')
	})
})

describe('probePort', () => {
	it('resolves true for a listening port', async () => {
		const server: Server = createServer()
		const port = await new Promise<number>((resolve) =>
			server.listen(0, '127.0.0.1', () =>
				resolve((server.address() as { port: number }).port),
			),
		)
		try {
			expect(await probePort(port, 500)).toBe(true)
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})

	it('resolves false for a port with nothing listening', async () => {
		// Port 1 is in the privileged range, outside the ephemeral range the OS
		// hands out for `listen(0)`, so no parallel test worker can transiently
		// grab it — a connect to 127.0.0.1:1 deterministically gets
		// ECONNREFUSED. (The previous "bind, close, re-probe the same ephemeral
		// port" was racy: another worker could re-bind that port in the window.)
		expect(await probePort(1, 500)).toBe(false)
	})
})

describe('PreviewServer.start startup abort', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'night-preview-start-'))
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('aborts a hung install via the signal instead of hanging forever', async () => {
		const ac = new AbortController()
		const started = PreviewServer.start({
			cwd: dir,
			logger: silentLogger,
			port: 4321,
			readyTimeoutMs: 1000,
			installCommand: 'sleep 30',
			signal: ac.signal,
		})
		setTimeout(() => ac.abort(), 50)
		await expect(started).rejects.toThrow(/aborted/)
	})

	it('rejects immediately if the signal is already aborted', async () => {
		await expect(
			PreviewServer.start({
				cwd: dir,
				logger: silentLogger,
				port: 4321,
				readyTimeoutMs: 1000,
				installCommand: 'sleep 30',
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow(/aborted/)
	})
})
