/**
 * End-to-end rebase test against a real *local* bare repo (no network, no
 * GitHub) via the `remoteUrl` override. Exercises the whole sequence the
 * `rebase` TaskKind relies on: fetch → worktree → rebase → conflict detection
 * → resolve + `--continue` → `--force-with-lease` push, plus the clean and
 * already-up-to-date fast paths.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git } from './git.ts'
import { RebaseConflictError, Workspace } from './workspace.ts'

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	trace: () => {},
	fatal: () => {},
	child: () => silentLogger,
} as unknown as Logger

const IDENT = {
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@e',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@e',
}
const gitc = (cwd: string, args: string[], env: Record<string, string> = {}) =>
	git(args, { cwd, env: { ...IDENT, ...env } })

/**
 * Build a bare "origin" with a `main` and a `feature` branch off a common
 * base. `feature`/`main` are the final contents of `f.txt` on each branch;
 * pass `advanceMain: false` to leave `main` at base (feature already current).
 */
async function seedRemote(
	root: string,
	opts: { feature: string; main: string; advanceMain?: boolean },
): Promise<string> {
	const origin = join(root, 'origin.git')
	await gitc(root, ['init', '--bare', '-b', 'main', origin])
	const seed = join(root, 'seed')
	await gitc(root, ['clone', origin, seed])
	await writeFile(join(seed, 'f.txt'), 'a\nbase\nc\n')
	await gitc(seed, ['add', '-A'])
	await gitc(seed, ['commit', '-m', 'base'])
	await gitc(seed, ['push', 'origin', 'main'])

	await gitc(seed, ['checkout', '-b', 'feature'])
	await writeFile(join(seed, 'f.txt'), opts.feature)
	await gitc(seed, ['commit', '-am', 'feat'])
	await gitc(seed, ['push', 'origin', 'feature'])

	if (opts.advanceMain !== false) {
		await gitc(seed, ['checkout', 'main'])
		await writeFile(join(seed, 'f.txt'), opts.main)
		await gitc(seed, ['commit', '-am', 'mainchange'])
		await gitc(seed, ['push', 'origin', 'main'])
	}
	return origin
}

function makeWorkspace(origin: string, workspaceDir: string): Promise<Workspace> {
	return Workspace.createForRebase({
		taskId: 't1',
		repo: 'owner/name',
		headRef: 'feature',
		baseRef: 'main',
		githubToken: 'unused-for-local',
		workspaceDir,
		logger: silentLogger,
		remoteUrl: origin,
	})
}

describe('Workspace rebase (local bare repo)', () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'night-rebase-'))
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('detects a conflict, supports resolve + continue, then leases the push', async () => {
		// feature and main both edit line 2 → conflicting rebase.
		const origin = await seedRemote(root, {
			feature: 'a\nFEATURE\nc\n',
			main: 'a\nMAIN\nc\n',
		})
		const ws = await makeWorkspace(origin, join(root, 'ws'))

		expect(await ws.countBehindBase()).toBe(1)

		await expect(ws.rebaseOntoBase({ leaveConflictInPlace: true })).rejects.toBeInstanceOf(
			RebaseConflictError,
		)
		// Rebase is paused with the conflict in place, not aborted.
		expect(await ws.rebaseInProgress()).toBe(true)
		expect(await ws.conflictedFiles()).toEqual(['f.txt'])

		// Simulate the agent's resolution: write a merged file, stage, continue.
		await writeFile(join(ws.path, 'f.txt'), 'a\nMERGED\nc\n')
		await gitc(ws.path, ['add', 'f.txt'])
		await gitc(ws.path, ['rebase', '--continue'], {
			GIT_EDITOR: 'true',
			GIT_SEQUENCE_EDITOR: 'true',
		})

		expect(await ws.rebaseInProgress()).toBe(false)
		expect(await ws.countBehindBase()).toBe(0)

		await ws.pushWithLease()
		const remoteSha = (await gitc(origin, ['rev-parse', 'feature'])).trim()
		expect(remoteSha).toBe(await ws.headSha())
	})

	it('rebases cleanly when changes do not collide and pushes the result', async () => {
		// feature edits line 1, main edits line 3 → no conflict.
		const origin = await seedRemote(root, {
			feature: 'FEAT\nbase\nc\n',
			main: 'a\nbase\nMAIN\n',
		})
		const ws = await makeWorkspace(origin, join(root, 'ws'))

		expect(await ws.countBehindBase()).toBe(1)
		const result = await ws.rebaseOntoBase({ leaveConflictInPlace: true })
		expect(result.rewroteCommits).toBe(true)
		expect(await ws.rebaseInProgress()).toBe(false)
		expect(await ws.countBehindBase()).toBe(0)

		await ws.pushWithLease()
		const remoteSha = (await gitc(origin, ['rev-parse', 'feature'])).trim()
		expect(remoteSha).toBe(result.newSha)
	})

	it('reports zero behind when the feature already contains base', async () => {
		const origin = await seedRemote(root, {
			feature: 'a\nFEATURE\nc\n',
			main: '',
			advanceMain: false,
		})
		const ws = await makeWorkspace(origin, join(root, 'ws'))
		expect(await ws.countBehindBase()).toBe(0)
	})

	it('runVerify reflects the command exit status in the worktree', async () => {
		const origin = await seedRemote(root, {
			feature: 'a\nFEATURE\nc\n',
			main: 'a\nMAIN\nc\n',
		})
		const ws = await makeWorkspace(origin, join(root, 'ws'))
		expect(await ws.runVerify('test -f f.txt')).toMatchObject({ ok: true })
		const bad = await ws.runVerify('echo nope >&2; exit 3')
		expect(bad.ok).toBe(false)
		expect(bad.output).toContain('nope')
	})
})
