/**
 * Stock tool implementations — file ops + bash. All operations are scoped
 * to a single workspace directory; paths are resolved and validated to
 * stay inside that root.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { redactBashOutput } from '@night/shared'
import type { ToolDefinition, ToolResult } from './types.ts'

const execFileP = promisify(execFile)

interface CreateOpts {
	root: string
	bashTimeoutMs?: number
	maxFileBytes?: number
	/** If set, injected as GH_TOKEN env var so `gh` commands work without login. */
	githubToken?: string | undefined
}

export function createDefaultTools(opts: CreateOpts): ToolDefinition[] {
	const root = resolve(opts.root)
	const bashTimeoutMs = opts.bashTimeoutMs ?? 60_000
	const maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024
	const ghEnv = opts.githubToken ? { GH_TOKEN: opts.githubToken } : {}

	const safePath = (p: unknown): string | { error: string } => {
		if (typeof p !== 'string' || p.length === 0)
			return { error: 'path must be a non-empty string' }
		const candidate = isAbsolute(p) ? p : resolve(root, p)
		const norm = normalize(candidate)
		const rel = relative(root, norm)
		if (rel.startsWith('..') || rel === '..' || resolve(root, rel) !== norm) {
			return { error: 'path escapes workspace root' }
		}
		return norm
	}

	const readFileTool: ToolDefinition = {
		name: 'read_file',
		description:
			'Read a UTF-8 file from the workspace. Returns the full contents (truncated for large files).',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to workspace root.' },
			},
			required: ['path'],
		},
		async run(input) {
			const { path: p } = (input ?? {}) as { path?: unknown }
			const sp = safePath(p)
			if (typeof sp !== 'string') return { output: sp.error, isError: true }
			try {
				const st = await stat(sp)
				if (!st.isFile()) return { output: 'not a regular file', isError: true }
				if (st.size > maxFileBytes) {
					return {
						output: `file too large (${st.size} bytes; limit ${maxFileBytes})`,
						isError: true,
					}
				}
				const content = await readFile(sp, 'utf8')
				return { output: content }
			} catch (err) {
				return { output: errString(err), isError: true }
			}
		},
	}

	const writeFileTool: ToolDefinition = {
		name: 'write_file',
		description:
			'Write the given content to a file in the workspace, creating parent directories as needed. Overwrites if the file exists.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path relative to workspace root.' },
				content: { type: 'string', description: 'Full file contents to write.' },
			},
			required: ['path', 'content'],
		},
		async run(input) {
			const { path: p, content } = (input ?? {}) as { path?: unknown; content?: unknown }
			if (typeof content !== 'string')
				return { output: 'content must be a string', isError: true }
			const sp = safePath(p)
			if (typeof sp !== 'string') return { output: sp.error, isError: true }
			try {
				await mkdir(dirname(sp), { recursive: true })
				await writeFile(sp, content, 'utf8')
				return { output: `wrote ${content.length} chars to ${relative(root, sp) || '.'}` }
			} catch (err) {
				return { output: errString(err), isError: true }
			}
		},
	}

	const bashTool: ToolDefinition = {
		name: 'bash',
		description:
			'Run a shell command in the workspace and return its stdout/stderr. Limited to a 60-second timeout. Use this for build, test, git status, package manager commands, etc.',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'Command line to pass to /bin/sh -c.' },
			},
			required: ['command'],
		},
		async run(input) {
			const { command } = (input ?? {}) as { command?: unknown }
			if (typeof command !== 'string' || command.trim().length === 0) {
				return { output: 'command must be a non-empty string', isError: true }
			}
			try {
				const { stdout, stderr } = await execFileP('/bin/sh', ['-c', command], {
					cwd: root,
					env: { ...process.env, ...ghEnv },
					timeout: bashTimeoutMs,
					maxBuffer: 5 * 1024 * 1024,
				})
				const combined = combineStreams(stdout.toString(), stderr.toString())
				return { output: redactBashOutput(combined) }
			} catch (err) {
				const e = err as {
					stdout?: Buffer | string
					stderr?: Buffer | string
					message: string
					code?: number
				}
				const stdout = e.stdout ? e.stdout.toString() : ''
				const stderr = e.stderr ? e.stderr.toString() : ''
				const combined = combineStreams(stdout, stderr) + `\n[exit ${e.code ?? 'n/a'}]`
				return { output: redactBashOutput(combined), isError: true }
			}
		},
	}

	return [readFileTool, writeFileTool, bashTool]
}

function combineStreams(stdout: string, stderr: string): string {
	if (stderr.trim().length === 0) return stdout
	if (stdout.trim().length === 0) return stderr
	return stdout + '\n--- stderr ---\n' + stderr
}

function errString(err: unknown): string {
	if (err instanceof Error) return err.message
	return String(err)
}
