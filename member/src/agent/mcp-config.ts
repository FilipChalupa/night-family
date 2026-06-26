/**
 * MCP (Model Context Protocol) server configuration — schema, parser, file
 * resolver and a small catalog of known servers used by the
 * `generate-mcp-config` CLI.
 *
 * Deliberately free of the MCP SDK so both the runtime manager (`mcp.ts`)
 * and the generator script can import this without pulling in the client
 * transports. The resolution chain mirrors `schedule.ts`:
 *
 *   1. `MCP_CONFIG_FILE` env var — explicit override.
 *   2. `/etc/night-family/mcp.yaml` — conventional Docker mount.
 *   3. `<repo-root>/mcp.yaml` — local dev fallback.
 *
 * If none exist the Member simply runs with no MCP tools — the feature is
 * opt-in and a missing file is never an error.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { findRepoRoot } from '../schedule.ts'

const FIXED_DOCKER_PATH = '/etc/night-family/mcp.yaml'
const DEFAULT_FILENAME = 'mcp.yaml'

/** A single MCP server the Member connects to. */
export interface McpServerConfig {
	/** Stable key, used as the `mcp__<name>__<tool>` namespace. */
	readonly name: string
	/**
	 * `stdio` spawns a local subprocess (most "bring your own token"
	 * servers); `http` / `sse` connect to a remote endpoint.
	 */
	readonly transport: 'stdio' | 'http' | 'sse'
	/** stdio: executable + args + child env. */
	readonly command?: string
	readonly args?: readonly string[]
	/**
	 * Child-process environment for stdio servers. Values may contain
	 * `${VAR}` references expanded from the Member's own env at connect time
	 * — keep secrets in `.env.member` and reference them here so the YAML
	 * stays commit-safe.
	 */
	readonly env?: Readonly<Record<string, string>>
	/** http / sse: endpoint URL. */
	readonly url?: string
	/** http / sse: extra request headers (e.g. `Authorization`). `${VAR}` expanded. */
	readonly headers?: Readonly<Record<string, string>>
	/**
	 * Allowlist of *bare* tool names (before namespacing) this server may
	 * expose. `null`/omitted = expose every tool the server advertises.
	 * Empty array = expose none. Default read-only allowlists are the
	 * safest posture for autonomous Members — write tools (send mail, post
	 * message, create issue) should be opted in explicitly.
	 */
	readonly allow?: readonly string[] | null
	/** Skip this server without deleting its block. Default false. */
	readonly disabled?: boolean
}

export interface McpConfig {
	readonly servers: readonly McpServerConfig[]
}

export interface ResolveMcpConfigResult {
	readonly config: McpConfig
	/** Absolute path of the source, or `null` when no file was found. */
	readonly source: string | null
}

const EMPTY: McpConfig = { servers: [] }

/**
 * Parse a `mcp.yaml`. Top-level shape mirrors the familiar `mcpServers`
 * map used by Claude Desktop / Cursor / VS Code so existing configs paste
 * in with minimal edits:
 *
 *   mcpServers:
 *     slack:
 *       command: npx
 *       args: ['-y', '@modelcontextprotocol/server-slack']
 *       env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' }
 *       allow: [slack_list_channels, slack_get_channel_history]
 *
 * Validates eagerly so a typo fails loudly at startup rather than silently
 * dropping a server.
 */
export function parseMcpConfig(yaml: string): McpConfig {
	const doc = parseYaml(yaml) as unknown
	if (doc == null) return EMPTY
	if (typeof doc !== 'object') {
		throw new Error('mcp config: top-level must be an object')
	}
	const o = doc as Record<string, unknown>
	const raw = o.mcpServers ?? o.servers
	if (raw === undefined) return EMPTY
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('mcp config: `mcpServers` must be a map of name → server')
	}

	const servers: McpServerConfig[] = []
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		servers.push(parseServer(name, value))
	}
	return { servers }
}

function parseServer(name: string, value: unknown): McpServerConfig {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`mcp config: server "${name}" must be an object`)
	}
	const s = value as Record<string, unknown>

	// Infer transport when omitted: a `command` means stdio, a `url` means http.
	const transport =
		typeof s.transport === 'string' ? s.transport : s.command !== undefined ? 'stdio' : 'http'
	if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
		throw new Error(
			`mcp config: server "${name}" transport must be stdio|http|sse, got: ${String(transport)}`,
		)
	}

	// Build incrementally so we never assign an explicit `undefined` to an
	// optional field (the repo runs with `exactOptionalPropertyTypes`).
	const command = optStr(s.command, name, 'command')
	const args = optStrArray(s.args, name, 'args')
	const env = optStrMap(s.env, name, 'env')
	const url = optStr(s.url, name, 'url')
	const headers = optStrMap(s.headers, name, 'headers')
	const out: McpServerConfig = {
		name,
		transport,
		allow: parseAllow(s.allow, name),
		disabled: s.disabled === true,
		...(command !== undefined ? { command } : {}),
		...(args !== undefined ? { args } : {}),
		...(env !== undefined ? { env } : {}),
		...(url !== undefined ? { url } : {}),
		...(headers !== undefined ? { headers } : {}),
	}

	if (transport === 'stdio' && !out.command) {
		throw new Error(`mcp config: stdio server "${name}" needs a \`command\``)
	}
	if (transport !== 'stdio' && !out.url) {
		throw new Error(`mcp config: ${transport} server "${name}" needs a \`url\``)
	}
	return out
}

function parseAllow(v: unknown, name: string): readonly string[] | null {
	if (v === undefined || v === null) return null
	if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
		throw new Error(`mcp config: server "${name}" \`allow\` must be a string array`)
	}
	return v as string[]
}

function optStr(v: unknown, name: string, field: string): string | undefined {
	if (v === undefined) return undefined
	if (typeof v !== 'string') {
		throw new Error(`mcp config: server "${name}" \`${field}\` must be a string`)
	}
	return v
}

function optStrArray(v: unknown, name: string, field: string): string[] | undefined {
	if (v === undefined) return undefined
	if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
		throw new Error(`mcp config: server "${name}" \`${field}\` must be a string array`)
	}
	return v as string[]
}

function optStrMap(v: unknown, name: string, field: string): Record<string, string> | undefined {
	if (v === undefined) return undefined
	if (typeof v !== 'object' || v === null || Array.isArray(v)) {
		throw new Error(`mcp config: server "${name}" \`${field}\` must be a map`)
	}
	const out: Record<string, string> = {}
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (typeof val !== 'string') {
			throw new Error(`mcp config: server "${name}" \`${field}.${k}\` must be a string`)
		}
		out[k] = val
	}
	return out
}

/**
 * Expand `${VAR}` references in a string from the given environment. Throws
 * on an unset reference so a missing secret fails loudly at startup, the
 * same way `required()` does for the core env vars. Non-reference text
 * (including any literal dollar sign) passes through untouched.
 */
export function expandEnvRefs(input: string, env: NodeJS.ProcessEnv = process.env): string {
	return input.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, key: string) => {
		const v = env[key]
		if (v === undefined || v === '') {
			throw new Error(
				`mcp config: \${${key}} is referenced but not set in the Member's environment`,
			)
		}
		return v
	})
}

/** Apply {@link expandEnvRefs} across every value of a string map. */
export function expandEnvMap(
	map: Readonly<Record<string, string>> | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
	if (!map) return undefined
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(map)) out[k] = expandEnvRefs(v, env)
	return out
}

/**
 * Locate and parse the active MCP config. Returns an empty server list (not
 * an error) when no file is found — the feature is opt-in.
 */
export function resolveMcpConfig(
	envPath: string | undefined = process.env.MCP_CONFIG_FILE,
): ResolveMcpConfigResult {
	if (envPath !== undefined && envPath !== '') {
		const path = isAbsolute(envPath) ? envPath : resolve(envPath)
		if (existsSync(path)) {
			return { config: parseMcpConfig(readFileSync(path, 'utf8')), source: path }
		}
		// An explicit path that doesn't exist is a likely misconfiguration —
		// surface it rather than silently falling back to "no MCP".
		throw new Error(`MCP_CONFIG_FILE points at a missing file: ${path}`)
	}
	const candidates = [FIXED_DOCKER_PATH]
	const root = findRepoRoot()
	if (root) candidates.push(resolve(root, DEFAULT_FILENAME))
	for (const path of candidates) {
		if (!existsSync(path)) continue
		return { config: parseMcpConfig(readFileSync(path, 'utf8')), source: path }
	}
	return { config: EMPTY, source: null }
}

// ---------------------------------------------------------------------------
// Catalog of known servers — drives the `generate-mcp-config` CLI. These are
// starting points, not guarantees: MCP server packages and tool names churn,
// so the generator stamps a "verify against the server's docs" note into the
// file it writes. The durable value here is the wiring (transport, which
// secrets, a sane read-only allowlist), not the exact package version.
// ---------------------------------------------------------------------------

/** How a server authenticates — surfaced to the user so the hard cases are obvious. */
export type AuthBucket = 'static-token' | 'basic' | 'oauth'

export interface KnownSecret {
	/** Env var name the Member must provide. */
	readonly env: string
	readonly label: string
	/** False for optional secrets (e.g. a workspace/team id). */
	readonly required: boolean
}

export interface KnownServer {
	readonly key: string
	readonly title: string
	readonly authBucket: AuthBucket
	/** One-liner shown in the picker, incl. any auth caveat. */
	readonly notes: string
	readonly transport: 'stdio' | 'http' | 'sse'
	readonly command?: string
	readonly args?: readonly string[]
	readonly url?: string
	/** Env vars wired into `env` (stdio) — `${ENV}` references by default. */
	readonly secrets: readonly KnownSecret[]
	/** Suggested read-only tool allowlist. */
	readonly readOnlyAllow: readonly string[]
}

export const KNOWN_SERVERS: readonly KnownServer[] = [
	{
		key: 'slack',
		title: 'Slack',
		authBucket: 'static-token',
		notes: 'Bot token (xoxb-…). Static, headless-friendly.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-slack'],
		secrets: [
			{ env: 'SLACK_BOT_TOKEN', label: 'Bot token (xoxb-…)', required: true },
			{ env: 'SLACK_TEAM_ID', label: 'Team ID (T…)', required: true },
		],
		readOnlyAllow: [
			'slack_list_channels',
			'slack_get_channel_history',
			'slack_get_thread_replies',
			'slack_get_users',
			'slack_get_user_profile',
		],
	},
	{
		key: 'jira',
		title: 'Jira / Confluence (Atlassian)',
		authBucket: 'basic',
		notes: 'Cloud: email + API token (basic auth). Static, headless-friendly.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', 'mcp-atlassian'],
		secrets: [
			{ env: 'JIRA_URL', label: 'Site URL (https://you.atlassian.net)', required: true },
			{ env: 'JIRA_USERNAME', label: 'Account email', required: true },
			{ env: 'JIRA_API_TOKEN', label: 'API token', required: true },
		],
		readOnlyAllow: ['jira_search', 'jira_get_issue', 'jira_get_issue_comments'],
	},
	{
		key: 'linear',
		title: 'Linear',
		authBucket: 'static-token',
		notes: 'Personal API key (lin_api_…) via a local server. Make it read-only in Linear.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@tacticlaunch/mcp-linear'],
		secrets: [{ env: 'LINEAR_API_KEY', label: 'Personal API key (lin_api_…)', required: true }],
		readOnlyAllow: ['linear_getIssueById', 'linear_searchIssues', 'linear_getComments'],
	},
	{
		key: 'github',
		title: 'GitHub',
		authBucket: 'static-token',
		notes: 'PAT. Members already have `gh`; useful for cross-repo search.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-github'],
		secrets: [{ env: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub PAT', required: true }],
		readOnlyAllow: ['search_repositories', 'search_issues', 'get_issue', 'get_file_contents'],
	},
	{
		key: 'notion',
		title: 'Notion',
		authBucket: 'static-token',
		notes: 'Internal integration token (secret_…). Static.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@notionhq/notion-mcp-server'],
		secrets: [{ env: 'NOTION_TOKEN', label: 'Integration token (secret_…)', required: true }],
		readOnlyAllow: ['search', 'fetch'],
	},
	{
		key: 'gdrive',
		title: 'Google Drive',
		authBucket: 'oauth',
		notes: 'Google OAuth — needs a one-time consent or a service account. The hard one.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-gdrive'],
		secrets: [
			{
				env: 'GDRIVE_CREDENTIALS_PATH',
				label: 'Path to OAuth credentials JSON',
				required: true,
			},
		],
		readOnlyAllow: ['gdrive_search', 'gdrive_read_file'],
	},
	{
		key: 'gmail',
		title: 'Gmail',
		authBucket: 'oauth',
		notes: 'Google OAuth — one-time consent stores a refresh token. The hard one.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
		secrets: [],
		readOnlyAllow: ['search_emails', 'read_email'],
	},
]

/**
 * Turn a catalog entry into a YAML-ready server object (the value under a
 * `mcpServers.<key>`). Secrets become `${VAR}` references so the written file
 * stays commit-safe. `readOnly` (the default) emits the curated allowlist;
 * full access omits `allow` so every advertised tool is exposed. Shared by
 * the generator and its tests so the two can't drift.
 */
export function catalogServerEntry(
	server: KnownServer,
	readOnly: boolean,
): Record<string, unknown> {
	const entry: Record<string, unknown> = {}
	if (server.transport !== 'stdio') entry.transport = server.transport
	if (server.command) entry.command = server.command
	if (server.args) entry.args = [...server.args]
	if (server.url) entry.url = server.url
	if (server.secrets.length > 0) {
		entry.env = Object.fromEntries(server.secrets.map((s) => [s.env, `\${${s.env}}`]))
	}
	if (readOnly) entry.allow = [...server.readOnlyAllow]
	return entry
}

/**
 * Render a fully commented starter `mcp.yaml` containing every catalog
 * server, all commented out. Mirrors `defaultScheduleYaml()` — the file is
 * meant to be read and edited, so it leads with how the pieces fit.
 */
export function defaultMcpConfigYaml(): string {
	const blocks = KNOWN_SERVERS.map((s) => renderCommentedServer(s)).join('\n')
	return `# Night Family member — MCP servers.
# Gives this member's agent extra tools from external services (Slack, Jira,
# Linear, Drive, …). Loaded at startup; the resolution order is:
#   1. MCP_CONFIG_FILE env var
#   2. /etc/night-family/mcp.yaml   (Docker mount)
#   3. <repo-root>/mcp.yaml         (local dev)
#
# Each server's tools are exposed to the agent namespaced as
# \`mcp__<name>__<tool>\`. A server that fails to connect is skipped — it
# never blocks task execution. Restart the member to apply changes.
#
# SECURITY:
#   - Keep secrets in .env.member and reference them here as \${VAR} so this
#     file stays safe to commit.
#   - \`allow:\` is a read-only allowlist by default. Add write tools (send
#     mail, post message, create issue) only deliberately — the agent is
#     autonomous.
#   - Tip: scope the upstream token itself to read-only where the service
#     supports it (Linear, GitHub fine-grained PATs, …).
#
# NOTE: package and tool names below are starting points — verify them
# against each server's own docs, they change over time. Run
# \`npm run member:generate-mcp-config\` for an interactive setup.

mcpServers:
${blocks}`
}

function renderCommentedServer(s: KnownServer): string {
	const lines: string[] = []
	lines.push(`  # --- ${s.title} (${s.authBucket}) — ${s.notes}`)
	const body: string[] = []
	body.push(`${s.key}:`)
	if (s.transport !== 'stdio') body.push(`  transport: ${s.transport}`)
	if (s.command) body.push(`  command: ${s.command}`)
	if (s.args) body.push(`  args: [${s.args.map((a) => `'${a}'`).join(', ')}]`)
	if (s.url) body.push(`  url: ${s.url}`)
	if (s.secrets.length > 0) {
		body.push(`  env:`)
		for (const sec of s.secrets) {
			body.push(`    ${sec.env}: '\${${sec.env}}'  # ${sec.label}`)
		}
	}
	body.push(`  allow: [${s.readOnlyAllow.join(', ')}]`)
	// Comment the whole block out — the file ships inert; the user uncomments
	// the servers they actually want.
	lines.push(...body.map((l) => `  # ${l}`))
	return lines.join('\n') + '\n'
}
