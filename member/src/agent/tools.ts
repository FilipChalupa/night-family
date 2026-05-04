/**
 * Stock tool implementations — file ops, bash, plus the GitHub
 * write-channel tools (`post_issue_comment` / `post_pr_comment` /
 * `post_pr_review`). All operations are scoped to a single workspace
 * directory; paths are resolved and validated to stay inside that root.
 *
 * Bash refuses comment/review/PR-create subcommands of `gh` and
 * redirects the agent to the dedicated `post_*` tools — that's how we
 * make sure every bot-authored thing lands on GitHub with the
 * `<!-- night-family:... -->` marker the Household webhook handler
 * relies on to skip its own comments.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { redactBashOutput } from '@night/shared'
import { appendAttribution, type AttributionInputs } from '@night/shared'
import type { ToolDefinition, ToolResult } from './types.ts'

const execFileP = promisify(execFile)

interface CreateOpts {
	root: string
	bashTimeoutMs?: number
	maxFileBytes?: number
	/** If set, injected as GH_TOKEN env var so `gh` commands work without login. */
	githubToken?: string | undefined
	/**
	 * Identity stamped onto every comment / review the agent posts. Required
	 * for the post_* tools; passed through `appendAttribution` so the body
	 * carries both the human-visible footer and the HTML marker.
	 */
	attribution: AttributionInputs
}

const REVIEW_VERDICTS = ['approve', 'request-changes', 'comment'] as const
type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

export function createDefaultTools(opts: CreateOpts): ToolDefinition[] {
	const root = resolve(opts.root)
	const bashTimeoutMs = opts.bashTimeoutMs ?? 60_000
	const maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024
	const ghEnv = opts.githubToken ? { GH_TOKEN: opts.githubToken } : {}
	const attribution = opts.attribution

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
			'Run a shell command in the workspace and return its stdout/stderr. Limited to a 60-second timeout. Use this for build, test, git status, package manager commands, and read-only `gh` queries (`gh issue view`, `gh pr diff`, `gh pr view`, `gh api`). Refuses `gh issue comment`, `gh pr comment`, `gh pr review`, `gh pr create`, `gh pr edit` — use the `post_*` tools instead.',
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
			const blocked = detectBlockedGh(command)
			if (blocked) {
				return {
					output:
						`Refused: \`gh ${blocked.sub}\` would post bot-authored content to GitHub without the Night Family attribution marker, which makes Household think your comment is a human reply and re-trigger triage. ` +
						`Use the appropriate dedicated tool instead:\n` +
						`  - \`post_issue_comment({ issue_url, body })\`\n` +
						`  - \`post_pr_comment({ pr_url, body })\`\n` +
						`  - \`post_pr_review({ pr_url, verdict, body })\`\n` +
						`PR creation/edit happens automatically once you stop calling tools — you don't need to invoke \`gh pr create\` / \`gh pr edit\` yourself.`,
					isError: true,
				}
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

	const runGh = async (
		args: string[],
	): Promise<{ ok: true; out: string } | { ok: false; err: string }> => {
		try {
			const { stdout } = await execFileP('gh', args, {
				cwd: root,
				env: { ...process.env, ...ghEnv },
				timeout: bashTimeoutMs,
				maxBuffer: 5 * 1024 * 1024,
			})
			return { ok: true, out: stdout.toString() }
		} catch (err) {
			const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number }
			const stderr = e.stderr ? e.stderr.toString() : ''
			const stdout = e.stdout ? e.stdout.toString() : ''
			return {
				ok: false,
				err:
					redactBashOutput(combineStreams(stdout, stderr)) +
					`\n[exit ${e.code ?? 'n/a'}]`,
			}
		}
	}

	const postIssueCommentTool: ToolDefinition = {
		name: 'post_issue_comment',
		description:
			"Post a comment on a GitHub issue. The body is sent verbatim and an attribution footer + Night Family marker are appended automatically — do NOT add them yourself. Use this whenever you'd otherwise reach for `gh issue comment`.",
		inputSchema: {
			type: 'object',
			properties: {
				issue_url: {
					type: 'string',
					description:
						'Full https URL of the issue (e.g. https://github.com/org/repo/issues/42).',
				},
				body: { type: 'string', description: 'Markdown body of the comment.' },
			},
			required: ['issue_url', 'body'],
		},
		async run(input) {
			const { issue_url, body } = (input ?? {}) as { issue_url?: unknown; body?: unknown }
			if (typeof issue_url !== 'string' || typeof body !== 'string') {
				return { output: 'issue_url and body must be strings', isError: true }
			}
			const final = appendAttribution(body, attribution)
			const r = await runGh(['issue', 'comment', issue_url, '--body', final])
			if (!r.ok) return { output: r.err, isError: true }
			return { output: r.out.trim() || 'comment posted' }
		},
	}

	const postPrCommentTool: ToolDefinition = {
		name: 'post_pr_comment',
		description:
			'Post a top-level comment on a GitHub pull request. Attribution footer + marker are appended automatically.',
		inputSchema: {
			type: 'object',
			properties: {
				pr_url: { type: 'string', description: 'Full https URL of the PR.' },
				body: { type: 'string', description: 'Markdown body of the comment.' },
			},
			required: ['pr_url', 'body'],
		},
		async run(input) {
			const { pr_url, body } = (input ?? {}) as { pr_url?: unknown; body?: unknown }
			if (typeof pr_url !== 'string' || typeof body !== 'string') {
				return { output: 'pr_url and body must be strings', isError: true }
			}
			const final = appendAttribution(body, attribution)
			const r = await runGh(['pr', 'comment', pr_url, '--body', final])
			if (!r.ok) return { output: r.err, isError: true }
			return { output: r.out.trim() || 'comment posted' }
		},
	}

	const postPrReviewTool: ToolDefinition = {
		name: 'post_pr_review',
		description:
			'Post a review on a GitHub pull request. `verdict` is one of `approve` / `request-changes` / `comment`. Attribution footer + marker are appended automatically. If the GitHub API rejects approve/request-changes (e.g. you authored the PR), fall back to verdict `comment` and report the desired verdict in the JSON block at the end of your turn.',
		inputSchema: {
			type: 'object',
			properties: {
				pr_url: { type: 'string', description: 'Full https URL of the PR.' },
				verdict: { type: 'string', enum: [...REVIEW_VERDICTS] },
				body: { type: 'string', description: 'Markdown review body.' },
			},
			required: ['pr_url', 'verdict', 'body'],
		},
		async run(input) {
			const { pr_url, verdict, body } = (input ?? {}) as {
				pr_url?: unknown
				verdict?: unknown
				body?: unknown
			}
			if (typeof pr_url !== 'string' || typeof body !== 'string') {
				return { output: 'pr_url and body must be strings', isError: true }
			}
			if (
				typeof verdict !== 'string' ||
				!(REVIEW_VERDICTS as readonly string[]).includes(verdict)
			) {
				return {
					output: `verdict must be one of ${REVIEW_VERDICTS.join('|')}, got ${JSON.stringify(verdict)}`,
					isError: true,
				}
			}
			const flag =
				verdict === 'approve'
					? '--approve'
					: verdict === 'request-changes'
						? '--request-changes'
						: '--comment'
			const final = appendAttribution(body, attribution)
			const r = await runGh(['pr', 'review', pr_url, flag, '--body', final])
			if (!r.ok) return { output: r.err, isError: true }
			return { output: r.out.trim() || `review posted (${verdict})` }
		},
	}

	return [
		readFileTool,
		writeFileTool,
		bashTool,
		postIssueCommentTool,
		postPrCommentTool,
		postPrReviewTool,
	]
}

/**
 * Detect bash commands that would post bot-authored content to GitHub
 * without going through our attribution-stamping `post_*` tools. Matches
 * the `gh` CLI invoked at any point in a compound shell command (start,
 * after `;`, `&&`, `|`, backtick, etc.) and limits the second word to
 * the unsafe subcommands. Returns a label like `pr review` for the error
 * message, or `null` if the command is fine.
 */
export function detectBlockedGh(command: string): { sub: string } | null {
	const re = /(?:^|[\s;|&`(])gh\s+(issue\s+comment|pr\s+(?:comment|review|create|edit))\b/
	const m = re.exec(command)
	if (!m) return null
	return { sub: m[1]!.replace(/\s+/g, ' ') }
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
