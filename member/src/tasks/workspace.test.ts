import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gcStaleTaskDirs, TASK_DIR_TTL_MS } from './workspace.ts'

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	trace: () => {},
	fatal: () => {},
	level: 'silent',
	child: () => silentLogger,
} as unknown as Logger

describe('gcStaleTaskDirs', () => {
	let workspaceDir: string

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), 'gc-task-dirs-'))
	})

	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true })
	})

	async function makeTaskDir(name: string, ageMs: number): Promise<string> {
		const path = join(workspaceDir, name)
		await mkdir(path, { recursive: true })
		await writeFile(join(path, 'events.ndjson'), '{}\n')
		const t = new Date(Date.now() - ageMs)
		await utimes(path, t, t)
		return path
	}

	it('removes task dirs older than TASK_DIR_TTL_MS', async () => {
		const taskId = 'abcdef01-2345-6789-abcd-ef0123456789'
		const old = await makeTaskDir(taskId, TASK_DIR_TTL_MS + 60_000)

		await gcStaleTaskDirs(workspaceDir, silentLogger)

		await expect(stat(old)).rejects.toThrow()
	})

	it('keeps task dirs younger than TASK_DIR_TTL_MS', async () => {
		const taskId = 'fresh001-0000-0000-0000-000000000000'
		const fresh = await makeTaskDir(taskId, 60_000) // 1 minute old

		await gcStaleTaskDirs(workspaceDir, silentLogger)

		await expect(stat(fresh)).resolves.toBeDefined()
	})

	it('skips the .cache dir even if it looks stale (cache GC owns that)', async () => {
		const cachePath = join(workspaceDir, '.cache')
		await mkdir(cachePath, { recursive: true })
		const t = new Date(Date.now() - TASK_DIR_TTL_MS - 60_000)
		await utimes(cachePath, t, t)

		await gcStaleTaskDirs(workspaceDir, silentLogger)

		await expect(stat(cachePath)).resolves.toBeDefined()
	})

	it('skips dirs whose names are not UUID-shaped (safety net for stray ops dirs)', async () => {
		const operatorDir = join(workspaceDir, 'operator-dropped-this')
		await mkdir(operatorDir, { recursive: true })
		const t = new Date(Date.now() - TASK_DIR_TTL_MS - 60_000)
		await utimes(operatorDir, t, t)

		await gcStaleTaskDirs(workspaceDir, silentLogger)

		await expect(stat(operatorDir)).resolves.toBeDefined()
	})

	it('does not crash when the workspace dir is missing', async () => {
		await rm(workspaceDir, { recursive: true, force: true })
		await expect(gcStaleTaskDirs(workspaceDir, silentLogger)).resolves.toBeUndefined()
	})
})
