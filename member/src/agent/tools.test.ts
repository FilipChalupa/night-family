import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultTools, detectBlockedGh } from './tools.ts'
import type { ToolDefinition } from './types.ts'

const STUB_ATTRIBUTION = {
	memberName: 'octo',
	memberId: 'm-test',
	taskId: 't-test',
	householdUrl: 'https://night.example',
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
	const t = tools.find((x) => x.name === name)
	if (!t) throw new Error(`tool ${name} not registered`)
	return t
}

describe('tools — workspace path safety', () => {
	let root: string
	let tools: ToolDefinition[]
	let read: ToolDefinition
	let write: ToolDefinition

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'tools-'))
		tools = createDefaultTools({ root, attribution: STUB_ATTRIBUTION })
		read = findTool(tools, 'read_file')
		write = findTool(tools, 'write_file')
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('write_file then read_file round-trips a file inside the workspace', async () => {
		const w = await write.run({ path: 'hello.txt', content: 'world' })
		expect(w.isError).toBeFalsy()
		const r = await read.run({ path: 'hello.txt' })
		expect(r.isError).toBeFalsy()
		expect(r.output).toBe('world')
	})

	it('write_file creates nested parent directories', async () => {
		const w = await write.run({ path: 'a/b/c/file.txt', content: 'nested' })
		expect(w.isError).toBeFalsy()
		const r = await read.run({ path: 'a/b/c/file.txt' })
		expect(r.output).toBe('nested')
	})

	it('rejects relative paths that escape the workspace via ..', async () => {
		const r = await read.run({ path: '../escape.txt' })
		expect(r.isError).toBe(true)
		expect(r.output).toMatch(/escapes workspace/)
		const w = await write.run({ path: '../escape.txt', content: 'x' })
		expect(w.isError).toBe(true)
		expect(w.output).toMatch(/escapes workspace/)
	})

	it('rejects deeply nested escape attempts', async () => {
		const r = await read.run({ path: 'a/b/../../../etc/passwd' })
		expect(r.isError).toBe(true)
		expect(r.output).toMatch(/escapes workspace/)
	})

	it('rejects absolute paths outside the workspace', async () => {
		const r = await read.run({ path: '/etc/passwd' })
		expect(r.isError).toBe(true)
		expect(r.output).toMatch(/escapes workspace/)
	})

	it('accepts an absolute path that resolves inside the workspace', async () => {
		await write.run({ path: 'inside.txt', content: 'ok' })
		const r = await read.run({ path: join(root, 'inside.txt') })
		expect(r.isError).toBeFalsy()
		expect(r.output).toBe('ok')
	})

	it.each([
		['empty string', ''],
		['null', null],
		['number', 42],
		['undefined', undefined],
	])('rejects %s as path (%s)', async (_label, value) => {
		const r = await read.run({ path: value })
		expect(r.isError).toBe(true)
	})

	it('write_file rejects non-string content', async () => {
		const w = await write.run({ path: 'x.txt', content: 123 })
		expect(w.isError).toBe(true)
		expect(w.output).toMatch(/content must be a string/)
	})

	it('read_file errors on missing file', async () => {
		const r = await read.run({ path: 'nope.txt' })
		expect(r.isError).toBe(true)
	})

	it('read_file errors on a directory (not a regular file)', async () => {
		await mkdir(join(root, 'subdir'), { recursive: true })
		const r = await read.run({ path: 'subdir' })
		expect(r.isError).toBe(true)
		expect(r.output).toMatch(/not a regular file/)
	})

	it('read_file enforces maxFileBytes', async () => {
		const small = createDefaultTools({ root, maxFileBytes: 4, attribution: STUB_ATTRIBUTION })
		const smallRead = findTool(small, 'read_file')
		await writeFile(join(root, 'big.txt'), 'too large', 'utf8')
		const r = await smallRead.run({ path: 'big.txt' })
		expect(r.isError).toBe(true)
		expect(r.output).toMatch(/too large/)
	})
})

describe('tools — bash', () => {
	let root: string
	let bash: ToolDefinition

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'tools-bash-'))
		bash = findTool(createDefaultTools({ root, attribution: STUB_ATTRIBUTION }), 'bash')
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('runs a successful command and returns its stdout', async () => {
		const r = await bash.run({ command: 'echo hello' })
		expect(r.isError).toBeFalsy()
		expect(r.output.trim()).toBe('hello')
	})

	it('reports a non-zero exit status as isError with stdout/stderr captured', async () => {
		const r = await bash.run({ command: 'echo out; echo err >&2; exit 3' })
		expect(r.isError).toBe(true)
		expect(r.output).toContain('out')
		expect(r.output).toContain('err')
		expect(r.output).toContain('[exit 3]')
	})

	it('runs in the workspace root (relative pwd is workspace)', async () => {
		await writeFile(join(root, 'marker.txt'), 'ok', 'utf8')
		const r = await bash.run({ command: 'ls marker.txt' })
		expect(r.isError).toBeFalsy()
		expect(r.output).toContain('marker.txt')
	})

	it('aborts a long-running command via the signal instead of hanging', async () => {
		const ac = new AbortController()
		const b = findTool(
			createDefaultTools({ root, attribution: STUB_ATTRIBUTION, abortSignal: ac.signal }),
			'bash',
		)
		const started = Date.now()
		const p = b.run({ command: 'sleep 30' })
		setTimeout(() => ac.abort(), 50)
		const r = await p
		expect(r.isError).toBe(true)
		// Interrupted promptly — nowhere near the 30s the command would take.
		expect(Date.now() - started).toBeLessThan(5000)
	}, 10_000)

	it('rejects empty / non-string commands', async () => {
		expect((await bash.run({ command: '' })).isError).toBe(true)
		expect((await bash.run({ command: '   ' })).isError).toBe(true)
		expect((await bash.run({ command: 42 })).isError).toBe(true)
	})

	it('redacts secrets from output', async () => {
		const r = await bash.run({
			command: 'echo "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"',
		})
		expect(r.output).toContain('[REDACTED]')
		expect(r.output).not.toContain('ghp_abcdef')
	})

	it('injects GH_TOKEN when configured', async () => {
		const tools = createDefaultTools({
			root,
			githubToken: 'fake-token-123',
			attribution: STUB_ATTRIBUTION,
		})
		const b = findTool(tools, 'bash')
		const r = await b.run({ command: 'echo "[$GH_TOKEN]"' })
		// The token appears in command echo; just verify it landed in the env.
		// (redactBashOutput would scrub a real ghp_ pattern; "fake-token-123"
		// is not a recognized secret, so it survives.)
		expect(r.output).toContain('fake-token-123')
	})

	it('does not inject GH_TOKEN by default', async () => {
		const r = await bash.run({ command: 'echo "[${GH_TOKEN:-unset}]"' })
		expect(r.output).toContain('[unset]')
	})

	it('honors a tight bash timeout', async () => {
		const tools = createDefaultTools({
			root,
			bashTimeoutMs: 100,
			attribution: STUB_ATTRIBUTION,
		})
		const b = findTool(tools, 'bash')
		const r = await b.run({ command: 'sleep 2' })
		expect(r.isError).toBe(true)
	})
})

describe('detectBlockedGh', () => {
	it.each([
		'gh issue comment 42 --body "hi"',
		'gh pr comment https://github.com/o/r/pull/1 --body "x"',
		'gh pr review https://github.com/o/r/pull/1 --approve --body "ok"',
		'gh pr create --title t --body b',
		'gh pr edit 1 --body new',
		'cd foo && gh pr review 1 --comment -b x',
		'echo done; gh issue comment 1 -b "y"',
	])('flags %j', (cmd) => {
		expect(detectBlockedGh(cmd)).not.toBeNull()
	})

	it.each([
		'gh issue view 42 --json title,body',
		'gh pr diff https://github.com/o/r/pull/1',
		'gh pr view 1 --comments',
		'gh api -X POST /repos/o/r/issues/1/reactions -f content=eyes',
		'echo "gh pr comment is what you want" # not a real call',
		'something gh-pr-comment 1', // hyphenated, not the gh CLI
	])('lets %j through', (cmd) => {
		expect(detectBlockedGh(cmd)).toBeNull()
	})
})

describe('post_pr_review one-shot guard', () => {
	let root: string
	let ghDir: string
	let originalPath: string | undefined
	let postPrReview: ToolDefinition

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'tools-review-'))
		ghDir = await mkdtemp(join(tmpdir(), 'fake-gh-'))
		// Stub `gh` on PATH so post_pr_review's exec succeeds without a real CLI.
		// `gh pr review … --approve --body …` returns nothing on success in real life.
		await writeFile(join(ghDir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
		originalPath = process.env.PATH
		process.env.PATH = `${ghDir}:${originalPath ?? ''}`
		postPrReview = findTool(
			createDefaultTools({ root, attribution: STUB_ATTRIBUTION }),
			'post_pr_review',
		)
	})

	afterEach(async () => {
		process.env.PATH = originalPath
		await rm(root, { recursive: true, force: true })
		await rm(ghDir, { recursive: true, force: true })
	})

	it('refuses a second post_pr_review in the same task', async () => {
		const first = await postPrReview.run({
			pr_url: 'https://github.com/o/r/pull/1',
			verdict: 'approve',
			body: 'looks good',
		})
		expect(first.isError).toBeFalsy()

		const second = await postPrReview.run({
			pr_url: 'https://github.com/o/r/pull/1',
			verdict: 'approve',
			body: 'looks good again',
		})
		expect(second.isError).toBe(true)
		expect(second.output).toMatch(/already been posted/i)
		expect(second.output).toMatch(/approve/)
	})

	it('does not consume the slot when the underlying gh call fails', async () => {
		// Replace the fake gh with one that exits non-zero, so the first call
		// errors out — the guard should NOT lock the tool in that case.
		await writeFile(join(ghDir, 'gh'), '#!/bin/sh\necho boom >&2\nexit 1\n', { mode: 0o755 })
		const failed = await postPrReview.run({
			pr_url: 'https://github.com/o/r/pull/1',
			verdict: 'approve',
			body: 'x',
		})
		expect(failed.isError).toBe(true)

		// Now make gh succeed and retry — should be allowed through.
		await writeFile(join(ghDir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
		const retry = await postPrReview.run({
			pr_url: 'https://github.com/o/r/pull/1',
			verdict: 'approve',
			body: 'x',
		})
		expect(retry.isError).toBeFalsy()
	})
})

describe('post_issue_comment one-shot guard (triage)', () => {
	let root: string
	let ghDir: string
	let originalPath: string | undefined

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'tools-comment-'))
		ghDir = await mkdtemp(join(tmpdir(), 'fake-gh-'))
		await writeFile(join(ghDir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
		originalPath = process.env.PATH
		process.env.PATH = `${ghDir}:${originalPath ?? ''}`
	})

	afterEach(async () => {
		process.env.PATH = originalPath
		await rm(root, { recursive: true, force: true })
		await rm(ghDir, { recursive: true, force: true })
	})

	it('refuses a second post_issue_comment when oneShotIssueComment is on', async () => {
		const tools = createDefaultTools({
			root,
			attribution: STUB_ATTRIBUTION,
			oneShotIssueComment: true,
		})
		const post = findTool(tools, 'post_issue_comment')

		const first = await post.run({
			issue_url: 'https://github.com/o/r/issues/1',
			body: 'hi',
		})
		expect(first.isError).toBeFalsy()

		const second = await post.run({
			issue_url: 'https://github.com/o/r/issues/1',
			body: 'hi again',
		})
		expect(second.isError).toBe(true)
		expect(second.output).toMatch(/already been posted/i)
	})

	it('allows multiple post_issue_comment calls when the flag is off (default)', async () => {
		const tools = createDefaultTools({ root, attribution: STUB_ATTRIBUTION })
		const post = findTool(tools, 'post_issue_comment')

		const first = await post.run({
			issue_url: 'https://github.com/o/r/issues/1',
			body: 'hi',
		})
		expect(first.isError).toBeFalsy()

		const second = await post.run({
			issue_url: 'https://github.com/o/r/issues/1',
			body: 'hi again',
		})
		expect(second.isError).toBeFalsy()
	})
})

describe('bash refusal of write-channel gh subcommands', () => {
	it('refuses `gh pr comment` and points at the dedicated tool', async () => {
		const root = await mkdtemp(join(tmpdir(), 'tools-'))
		try {
			const bash = findTool(
				createDefaultTools({ root, attribution: STUB_ATTRIBUTION }),
				'bash',
			)
			const r = await bash.run({ command: 'gh pr comment 1 --body hi' })
			expect(r.isError).toBe(true)
			expect(r.output).toMatch(/post_pr_comment/)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
