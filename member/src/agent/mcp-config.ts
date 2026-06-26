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

/**
 * Render a generic, fully-commented starter `mcp.yaml`. Night Family has no
 * built-in knowledge of any specific service — every MCP server publishes its
 * own config snippet in its docs. This template shows the two shapes (a local
 * stdio subprocess and a remote HTTP/SSE endpoint), the `${VAR}` secret
 * convention and the `allow` allowlist, all commented out. Mirrors
 * `defaultScheduleYaml()`: meant to be read and edited.
 */
export function defaultMcpConfigYaml(): string {
	return `# Night Family member — MCP servers.
# Gives this member's agent extra tools from external MCP servers so it can
# resolve what an issue points at (a ticket, a chat thread, a linked doc)
# instead of guessing. Loaded at startup; resolution order:
#   1. MCP_CONFIG_FILE env var
#   2. /etc/night-family/mcp.yaml   (Docker mount)
#   3. <repo-root>/mcp.yaml         (local dev)
#
# Each server's tools are exposed to the agent namespaced as
# \`mcp__<name>__<tool>\`. A server that fails to connect is skipped — it
# never blocks task execution. Restart the member to apply changes.
#
# This is a GENERIC template. Night Family doesn't ship a catalog of services
# — every MCP server publishes a config snippet in its own docs. Copy that
# snippet under \`mcpServers:\`, point its secrets at .env.member, and (ideally)
# restrict \`allow\` to the read tools you want. The two blocks below show the
# only two shapes there are.
#
# SECURITY:
#   - Keep secrets in .env.member and reference them here as \${VAR} so this
#     file stays safe to commit.
#   - \`allow:\` is an optional allowlist of tool names. Omit it to expose every
#     tool the server advertises; set it to a read-only subset (recommended —
#     the agent is autonomous). Add write tools only deliberately.
#   - Prefer scoping the upstream token itself to read-only where supported.

mcpServers:
  # --- A local server (stdio): Night Family spawns it as a subprocess. ---
  # example-stdio:
  #   command: some-mcp-server        # the executable: a binary, or npx / uvx
  #   args: ['--some-flag', 'value']
  #   env:
  #     SOME_API_TOKEN: '\${SOME_API_TOKEN}'   # real value goes in .env.member
  #   allow: [search, get_item]       # omit this line to expose all tools

  # --- A remote server (HTTP/SSE): Night Family connects over the network. ---
  # example-remote:
  #   transport: http                 # or: sse
  #   url: https://mcp.example.com/mcp
  #   headers:
  #     Authorization: 'Bearer \${SOME_API_TOKEN}'
  #   allow: [search, fetch]
`
}
