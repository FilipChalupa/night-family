/**
 * PreviewServer — the `preview` skill's foundation.
 *
 * Given a checked-out repo (see {@link checkoutBranch}), it:
 *   1. installs dependencies (detected from the lockfile),
 *   2. starts the project's dev/preview server (detected from package.json),
 *   3. auto-detects the bound URL by scanning the server's stdout/stderr for the
 *      first `http(s)://…` it prints ({@link normalizeUrl} rewrites `0.0.0.0`/
 *      `[::]` to `localhost`); falls back to `http://localhost:<port>` only if
 *      nothing is printed before `readyTimeoutMs`,
 *   4. hands back a {@link RunningPreview} you can later `stop()`.
 *
 * Exposing the URL *online* is layered on top, not here: the runner turns the
 * detected local URL into the published one (local as-is, or a Household-domain
 * redirect link), and Household resolves it — see {@link PreviewPublisher},
 * `household/src/preview/proxy.ts`, and the README.
 *
 * Deliberately simple, with room to grow: framework detection picks one start
 * command, and only the primary port's readiness is probed (URL detection) —
 * additional ports a preview exposes are declared via `PREVIEW_PORTS`, not
 * auto-discovered.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { connect as netConnect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'
import { gh, GitError } from './git.ts'

export interface PreviewOptions {
	/** Checked-out repo root (from `checkoutBranch`). */
	cwd: string
	logger: Logger
	/** Port we ask the dev server to bind (injected as `PORT`). */
	port: number
	/** How long to wait for the server to come up before giving up. */
	readyTimeoutMs: number
	/** Override the detected start command (e.g. `npm run dev`). */
	command?: string | null
	/** Override the detected install command; pass `null` to skip install. */
	installCommand?: string | null
	/** Extra env for the spawned process. */
	env?: Record<string, string>
	/** Called once per stdout/stderr line — wire this to event emission. */
	onLog?: (line: string) => void
}

export interface RunningPreview {
	/** Local URL on the Member host, e.g. `http://localhost:5173`. */
	url: string
	port: number
	pid: number
	/** The command that was run. */
	command: string
	/** Stop the server (SIGTERM → SIGKILL) and resolve when it has exited. */
	stop(): Promise<void>
}

/** Matches the first `http://…`/`https://…` URL a dev server prints. */
const URL_RE = /(https?:\/\/[^\s/$.?#].[^\s)'"]*)/i

export class PreviewServer {
	/**
	 * Boot a preview server in `opts.cwd`. Rejects if no start command can be
	 * detected, install fails, or the server does not become ready in time.
	 */
	static async start(opts: PreviewOptions): Promise<RunningPreview> {
		const { cwd, logger } = opts

		const pkg = await readPackageJson(cwd)

		const installCommand =
			opts.installCommand === undefined ? detectInstallCommand(cwd) : opts.installCommand
		if (installCommand) {
			logger.info({ installCommand }, 'preview: installing dependencies')
			await runToCompletion(installCommand, cwd, opts.env, opts.onLog)
		}

		const command = opts.command ?? detectStartCommand(pkg)
		if (!command) {
			throw new Error(
				'preview: could not detect a start command (looked for package.json scripts dev/preview/start)',
			)
		}

		logger.info({ command, port: opts.port }, 'preview: starting server')
		return await spawnServer(command, opts)
	}
}

// ─── Detection ──────────────────────────────────────────────────────────────

interface PackageJson {
	scripts?: Record<string, string>
}

async function readPackageJson(cwd: string): Promise<PackageJson> {
	const p = join(cwd, 'package.json')
	if (!existsSync(p)) return {}
	try {
		return JSON.parse(await readFile(p, 'utf8')) as PackageJson
	} catch {
		return {}
	}
}

/** Pick an install command from the lockfile present in the repo. */
export function detectInstallCommand(cwd: string): string | null {
	if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile'
	if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn install --frozen-lockfile'
	if (existsSync(join(cwd, 'package-lock.json'))) return 'npm ci'
	if (existsSync(join(cwd, 'package.json'))) return 'npm install'
	return null
}

/**
 * Pick a start command from package.json scripts, preferring a long-lived dev
 * server. Order: `dev` → `preview` → `start`. Returns null if none exist.
 *
 * TODO: framework-aware detection (Next/Vite/CRA/Astro/…), non-Node stacks
 * (Procfile, docker-compose, Makefile), and honouring a repo-level
 * `.night/preview` hint file.
 */
export function detectStartCommand(pkg: PackageJson): string | null {
	const scripts = pkg.scripts ?? {}
	for (const name of ['dev', 'preview', 'start']) {
		if (scripts[name]) return `npm run ${name}`
	}
	return null
}

// ─── Readiness probe ────────────────────────────────────────────────────────

/** Resolve true if something is accepting TCP connections on `port`. */
export function probePort(port: number, timeoutMs = 1000, host = '127.0.0.1'): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = netConnect({ host, port })
		const finish = (ok: boolean) => {
			socket.destroy()
			resolve(ok)
		}
		socket.setTimeout(timeoutMs)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(false))
		socket.once('error', () => finish(false))
	})
}

/** Poll {@link probePort} until the port is up or `totalMs` elapses. */
export async function probePortReady(port: number, totalMs: number): Promise<boolean> {
	const deadline = Date.now() + totalMs
	for (;;) {
		if (await probePort(port, 1000)) return true
		if (Date.now() >= deadline) return false
		await sleep(500)
	}
}

// ─── Process management ─────────────────────────────────────────────────────

function baseEnv(opts: PreviewOptions): Record<string, string> {
	return {
		...process.env,
		...opts.env,
		// Common conventions so frameworks bind where we expect them.
		PORT: String(opts.port),
		HOST: '0.0.0.0',
		BROWSER: 'none',
		CI: '1',
	}
}

/** Run a one-shot command (install) to completion; reject on non-zero exit. */
function runToCompletion(
	command: string,
	cwd: string,
	env: Record<string, string> | undefined,
	onLog?: (line: string) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, {
			cwd,
			env: { ...process.env, ...env },
			shell: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		pipeLines(child, onLog)
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code === 0) resolve()
			else reject(new Error(`command failed (exit ${code}): ${command}`))
		})
	})
}

/** Spawn the long-lived server and resolve once it looks ready. */
function spawnServer(command: string, opts: PreviewOptions): Promise<RunningPreview> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, {
			cwd: opts.cwd,
			env: baseEnv(opts),
			shell: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true, // own process group, so stop() can kill the whole tree
		})

		let settled = false
		const finish = (fn: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			fn()
		}

		const timer = setTimeout(() => {
			// Server never printed a URL — fall back to the assumed local URL
			// rather than failing, so we can still try to reach it.
			finish(() => {
				opts.logger.warn(
					{ timeoutMs: opts.readyTimeoutMs },
					'preview: no URL detected before timeout, assuming localhost',
				)
				resolve(makeHandle(child, command, opts, `http://localhost:${opts.port}`))
			})
		}, opts.readyTimeoutMs)
		timer.unref()

		pipeLines(child, (line) => {
			opts.onLog?.(line)
			const detected = line.match(URL_RE)?.[1]
			if (detected && !settled) {
				finish(() =>
					resolve(makeHandle(child, command, opts, normalizeUrl(detected, opts.port))),
				)
			}
		})

		child.on('error', (err) => finish(() => reject(err)))
		child.on('exit', (code) =>
			finish(() =>
				reject(new Error(`preview server exited early (code ${code}): ${command}`)),
			),
		)
	})
}

function makeHandle(
	child: ChildProcess,
	command: string,
	opts: PreviewOptions,
	url: string,
): RunningPreview {
	opts.logger.info({ url, pid: child.pid }, 'preview: server ready')
	return {
		url,
		port: opts.port,
		pid: child.pid ?? -1,
		command,
		stop: () => killTree(child, opts.logger),
	}
}

/** Rewrite `0.0.0.0`/`127.0.0.1` hosts to `localhost` and trust our port. */
export function normalizeUrl(raw: string, port: number): string {
	try {
		const u = new URL(raw)
		if (u.hostname === '0.0.0.0' || u.hostname === '[::]') u.hostname = 'localhost'
		if (!u.port) u.port = String(port)
		return u.toString().replace(/\/$/, '')
	} catch {
		return raw
	}
}

/** Stream a child's stdout+stderr to `onLog`, one trimmed line at a time. */
function pipeLines(child: ChildProcess, onLog?: (line: string) => void): void {
	if (!onLog) return
	for (const stream of [child.stdout, child.stderr]) {
		let buf = ''
		stream?.on('data', (chunk: Buffer) => {
			buf += chunk.toString()
			let nl: number
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl).trimEnd()
				buf = buf.slice(nl + 1)
				if (line) onLog(line)
			}
		})
	}
}

/** SIGTERM the process group, escalate to SIGKILL, resolve on exit. */
function killTree(child: ChildProcess, logger: Logger): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve()
		const pid = child.pid
		const done = () => resolve()
		child.once('exit', done)

		const signal = (sig: NodeJS.Signals) => {
			try {
				// Negative pid → whole process group (we spawned detached).
				if (pid) process.kill(-pid, sig)
				else child.kill(sig)
			} catch (err) {
				logger.warn({ err: (err as Error).message, sig }, 'preview: kill failed')
			}
		}

		signal('SIGTERM')
		const escalate = setTimeout(() => signal('SIGKILL'), 5_000)
		escalate.unref()
	})
}

// ─── Online exposure (pluggable, decided later) ─────────────────────────────

/**
 * Turns a Member-local preview URL into something reachable from outside.
 *
 * The default {@link LocalPublisher} is a no-op (returns the localhost URL) —
 * useful for same-host testing.
 *
 * Chosen direction: **Household reverse proxy.** Members register
 * `preview-<id>.previews.<domain>` with the Household (which is already
 * partially internet-exposed for GitHub webhooks), and it proxies inbound
 * traffic to the Member's local port. Keeps URLs on our own domain; still to
 * solve: wildcard DNS/TLS and Member reachability from the Household.
 *
 * Alternatives kept in mind: an outbound tunnel (cloudflared / ngrok /
 * tailscale funnel) if Member reachability proves painful, or a per-preview
 * container + ingress (Traefik/Caddy) once previews get their own containers.
 */
export interface PreviewPublisher {
	publish(local: RunningPreview): Promise<{ publicUrl: string; stop(): Promise<void> }>
}

export const LocalPublisher: PreviewPublisher = {
	async publish(local) {
		return { publicUrl: local.url, async stop() {} }
	},
}

// ─── PR annotation ──────────────────────────────────────────────────────────

const PREVIEW_MARK_START = '<!-- night-preview:start -->'
const PREVIEW_MARK_END = '<!-- night-preview:end -->'

export interface PreviewAnnotation {
	/** A git working dir for `gh` (the preview checkout). */
	cwd: string
	githubToken: string
	repo: string // org/name
	ref: string // branch being previewed
	memberName: string
	status: 'running' | 'stopped'
	/** Exposed ports to link, one line each. Omitted/empty when stopped. */
	ports?: Array<{ label: string; url: string }>
	sha?: string
}

/**
 * Write a "Preview" section into the PR opened for `ref`, if one exists.
 * Idempotent: the section is delimited by HTML comment markers, so repeated
 * calls (start → stop) update in place instead of stacking up. Returns the PR
 * URL it annotated, or null when the branch has no open PR.
 *
 * Best-effort by design — a preview that can't find/edit a PR still runs.
 */
export async function annotatePrWithPreview(
	a: PreviewAnnotation,
	logger: Logger,
): Promise<string | null> {
	try {
		const listed = await gh(
			[
				'pr',
				'list',
				'--repo',
				a.repo,
				'--head',
				a.ref,
				'--state',
				'open',
				'--json',
				'number,body,url',
				'--limit',
				'1',
			],
			{ cwd: a.cwd, token: a.githubToken },
		)
		const prs = JSON.parse(listed) as Array<{ number: number; body: string; url: string }>
		const pr = prs[0]
		if (!pr) {
			logger.info({ ref: a.ref }, 'preview: no open PR to annotate')
			return null
		}

		const newBody = upsertPreviewSection(pr.body ?? '', renderPreviewSection(a))
		await gh(['pr', 'edit', String(pr.number), '--repo', a.repo, '--body', newBody], {
			cwd: a.cwd,
			token: a.githubToken,
		})
		logger.info({ pr: pr.url, status: a.status }, 'preview: PR annotated')
		return pr.url
	} catch (err) {
		const detail = err instanceof GitError ? err.stderr.slice(0, 200) : (err as Error).message
		logger.warn({ err: detail }, 'preview: PR annotation failed (non-fatal)')
		return null
	}
}

function renderPreviewSection(a: PreviewAnnotation): string {
	const lines = [PREVIEW_MARK_START, '## 🔎 Preview', '']
	const ports = a.ports ?? []
	if (a.status === 'running' && ports.length > 0) {
		// One bullet per exposed port; a single-port preview reads as one line.
		for (const p of ports) {
			const label = ports.length > 1 ? ` **${p.label}**` : ''
			lines.push(`▶ Running${label}: ${p.url}`)
		}
	} else {
		lines.push('⏹ **Stopped**')
	}
	const meta = [`member \`${a.memberName}\``, `branch \`${a.ref}\``]
	if (a.sha) meta.push(`commit \`${a.sha.slice(0, 8)}\``)
	lines.push('', meta.join(' · '), PREVIEW_MARK_END)
	return lines.join('\n')
}

/** Replace the marked section if present, otherwise append it. */
export function upsertPreviewSection(body: string, section: string): string {
	const start = body.indexOf(PREVIEW_MARK_START)
	const end = body.indexOf(PREVIEW_MARK_END)
	if (start !== -1 && end !== -1 && end > start) {
		const before = body.slice(0, start)
		const after = body.slice(end + PREVIEW_MARK_END.length)
		return (before.trimEnd() + '\n\n' + section + after).trim() + '\n'
	}
	return (body.trim() + '\n\n' + section).trim() + '\n'
}
