/**
 * Thin wrapper around `git` and `gh` CLI commands. Uses execFile (no shell)
 * to avoid argument injection. The Member runs inside a sandboxed container
 * so we can spawn freely.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export class GitError extends Error {
	constructor(
		message: string,
		readonly stderr: string,
		readonly cmd: string,
	) {
		super(message)
		this.name = 'GitError'
	}
}

export interface GitOptions {
	cwd: string
	env?: Record<string, string>
	timeoutMs?: number
}

export async function git(args: string[], opts: GitOptions): Promise<string> {
	const env = { ...process.env, ...(opts.env ?? {}), GIT_TERMINAL_PROMPT: '0' }
	try {
		const { stdout } = await execFileP('git', args, {
			cwd: opts.cwd,
			env,
			timeout: opts.timeoutMs ?? 60_000,
			maxBuffer: 10 * 1024 * 1024,
		})
		return stdout.toString()
	} catch (err) {
		const e = err as { stderr?: Buffer | string; message: string }
		const stderr = e.stderr ? e.stderr.toString() : ''
		throw new GitError(`git ${args[0]} failed: ${e.message}`, stderr, `git ${args.join(' ')}`)
	}
}

export async function gh(args: string[], opts: GitOptions & { token?: string }): Promise<string> {
	const env = {
		...process.env,
		...(opts.env ?? {}),
		...(opts.token ? { GH_TOKEN: opts.token } : {}),
	}
	try {
		const { stdout } = await execFileP('gh', args, {
			cwd: opts.cwd,
			env,
			timeout: opts.timeoutMs ?? 60_000,
			maxBuffer: 10 * 1024 * 1024,
		})
		return stdout.toString()
	} catch (err) {
		const e = err as { stderr?: Buffer | string; message: string }
		const stderr = e.stderr ? e.stderr.toString() : ''
		throw new GitError(`gh ${args[0]} failed: ${e.message}`, stderr, `gh ${args.join(' ')}`)
	}
}

/**
 * Build an authenticated remote URL: https://x-access-token:<token>@github.com/<repo>.git
 * The `x-access-token` username works for both PATs and GitHub App installation tokens.
 */
export function authenticatedRemoteUrl(repo: string, token: string): string {
	return `https://x-access-token:${token}@github.com/${repo}.git`
}
