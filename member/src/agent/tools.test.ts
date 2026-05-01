import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultTools } from './tools.ts'
import type { ToolDefinition } from './types.ts'

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
		tools = createDefaultTools({ root })
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
		const small = createDefaultTools({ root, maxFileBytes: 4 })
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
		bash = findTool(createDefaultTools({ root }), 'bash')
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
		const tools = createDefaultTools({ root, githubToken: 'fake-token-123' })
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
		const tools = createDefaultTools({ root, bashTimeoutMs: 100 })
		const b = findTool(tools, 'bash')
		const r = await b.run({ command: 'sleep 2' })
		expect(r.isError).toBe(true)
	})
})
