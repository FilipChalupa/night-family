/**
 * MCP runtime — connects to the configured MCP servers at Member startup and
 * exposes their tools as ordinary {@link ToolDefinition}s, so the existing
 * provider adapters (Anthropic / Gemini / OpenAI) pick them up unchanged.
 *
 * Design notes:
 *   - A server that fails to connect (down, bad token, slow spawn) is logged
 *     and skipped. MCP is an enhancement, never a hard dependency of task
 *     execution — a broken Slack server must not stop the Member implementing
 *     code.
 *   - Tools are namespaced `mcp__<server>__<tool>` so two servers can expose a
 *     `search` without colliding, and the name stays within the
 *     `^[a-zA-Z0-9_-]{1,128}$` shape every provider requires.
 *   - The `allow` list (read-only by default) is applied here, before the
 *     agent ever sees a tool — defense in depth on top of scoping the upstream
 *     token.
 *   - Connections are opened once and shared across every task this Member
 *     runs; the tools talk to external services, not the per-task workspace.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { redactBashOutput } from '@night/shared'
import type { Logger } from 'pino'
import { expandEnvMap, type McpServerConfig } from './mcp-config.ts'
import type { ToolDefinition, ToolResult } from './types.ts'

/** How long a single server gets to connect + list tools before we give up. */
const CONNECT_TIMEOUT_MS = 20_000
/** Per call cap, so a chatty MCP tool can't blow the context budget. */
const MAX_OUTPUT_CHARS = 60_000

/** The slice of the MCP client this module actually uses — keeps tests honest. */
export interface McpToolCaller {
	callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>
}

/** A tool descriptor as returned by `tools/list`. */
export interface McpToolDescriptor {
	name: string
	description?: string
	inputSchema?: Record<string, unknown>
}

/**
 * Wrap one MCP tool as a Night Family {@link ToolDefinition}. Pure (no SDK,
 * no I/O beyond the injected `caller`) so the namespacing, schema fallback,
 * result flattening and error handling are unit-testable without a live
 * server.
 */
export function wrapMcpTool(
	serverName: string,
	descriptor: McpToolDescriptor,
	caller: McpToolCaller,
): ToolDefinition {
	const safeName = sanitizeToolName(`mcp__${serverName}__${descriptor.name}`)
	const description =
		`[via ${serverName} MCP] ${descriptor.description ?? ''}`.trim() +
		`\n(Tool "${descriptor.name}" from the ${serverName} server.)`
	// Anthropic/Gemini reject a tool with no `type: object` schema; MCP servers
	// usually supply one, but fall back to a permissive object just in case.
	const inputSchema =
		descriptor.inputSchema && typeof descriptor.inputSchema === 'object'
			? descriptor.inputSchema
			: { type: 'object', properties: {} }

	return {
		name: safeName,
		description,
		inputSchema,
		async run(input: unknown): Promise<ToolResult> {
			const args =
				input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
			let raw: unknown
			try {
				raw = await caller.callTool({ name: descriptor.name, arguments: args })
			} catch (err) {
				return {
					output: `MCP call to ${serverName}/${descriptor.name} failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
					isError: true,
				}
			}
			return flattenResult(raw)
		},
	}
}

/** MCP tool names must match the provider tool-name shape; coerce + truncate. */
function sanitizeToolName(name: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_')
	return cleaned.slice(0, 128)
}

/**
 * Flatten a `CallToolResult` into our string-output `ToolResult`. Joins text
 * blocks; non-text blocks (images, embedded resources) are noted rather than
 * dumped. Output is redacted (secret patterns) and capped.
 */
function flattenResult(raw: unknown): ToolResult {
	const result = raw as { content?: unknown; isError?: unknown }
	const isError = result?.isError === true
	const content = Array.isArray(result?.content) ? result.content : []
	const parts: string[] = []
	for (const block of content) {
		const b = block as { type?: string; text?: string; resource?: { uri?: string } }
		if (b?.type === 'text' && typeof b.text === 'string') {
			parts.push(b.text)
		} else if (b?.type === 'resource' && b.resource?.uri) {
			parts.push(`[resource: ${b.resource.uri}]`)
		} else if (b?.type) {
			parts.push(`[${b.type} content omitted]`)
		}
	}
	let output = parts.join('\n').trim()
	if (output.length === 0) output = isError ? '(MCP tool reported an error)' : '(no output)'
	output = redactBashOutput(output)
	if (output.length > MAX_OUTPUT_CHARS) {
		output = output.slice(0, MAX_OUTPUT_CHARS) + '\n…(truncated)'
	}
	return { output, isError }
}

interface OpenServer {
	name: string
	client: Client
	transport: Transport
	/** Tools exposed to the agent after the allowlist — surfaced to Household. */
	toolCount: number
}

/** Per-server summary reported to Household at handshake. */
export interface McpServerSummary {
	name: string
	toolCount: number
}

/**
 * Owns the live MCP connections for a Member. Call {@link connect} once at
 * startup, read {@link tools} per task, and {@link close} on shutdown.
 */
export class McpManager {
	private readonly open: OpenServer[] = []
	private _tools: ToolDefinition[] = []

	constructor(
		private readonly servers: readonly McpServerConfig[],
		private readonly logger: Logger,
	) {}

	/** Tools from every server that connected successfully. Stable after connect. */
	get tools(): ToolDefinition[] {
		return this._tools
	}

	/** Names of servers that are live, for logging/observability. */
	get connectedServers(): string[] {
		return this.open.map((o) => o.name)
	}

	/** Connected servers with their exposed tool counts, for the Household UI. */
	get serverSummaries(): McpServerSummary[] {
		return this.open.map((o) => ({ name: o.name, toolCount: o.toolCount }))
	}

	/**
	 * Connect to every enabled server in parallel. Never throws: a server that
	 * fails is logged and left out. Returns the tools it managed to assemble.
	 */
	async connect(): Promise<ToolDefinition[]> {
		const enabled = this.servers.filter((s) => !s.disabled)
		const results = await Promise.all(enabled.map((s) => this.connectOne(s)))
		this._tools = results.flat()
		this.logger.info(
			{
				servers: this.connectedServers,
				toolCount: this._tools.length,
				configured: enabled.length,
			},
			'mcp ready',
		)
		return this._tools
	}

	private async connectOne(server: McpServerConfig): Promise<ToolDefinition[]> {
		const log = this.logger.child({ mcpServer: server.name })
		try {
			const transport = buildTransport(server)
			const client = new Client({ name: 'night-family-member', version: '0.0.0' })
			await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'connect')
			const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'listTools')

			const allow = server.allow == null ? null : new Set(server.allow)
			const tools: ToolDefinition[] = []
			let skipped = 0
			for (const descriptor of listed.tools as McpToolDescriptor[]) {
				if (allow && !allow.has(descriptor.name)) {
					skipped++
					continue
				}
				tools.push(wrapMcpTool(server.name, descriptor, client))
			}
			this.open.push({ name: server.name, client, transport, toolCount: tools.length })
			log.info(
				{ exposed: tools.length, skipped, advertised: listed.tools.length },
				'mcp server connected',
			)
			return tools
		} catch (err) {
			// A broken server is non-fatal — log loudly and carry on without it.
			log.warn({ err }, 'mcp server failed to connect — skipping its tools')
			return []
		}
	}

	/** Close every connection. Best-effort; errors are swallowed. */
	async close(): Promise<void> {
		await Promise.all(
			this.open.map(async (o) => {
				try {
					await o.client.close()
				} catch {
					// already gone / process exiting — nothing useful to do
				}
			}),
		)
		this.open.length = 0
	}
}

function buildTransport(server: McpServerConfig): Transport {
	if (server.transport === 'stdio') {
		if (!server.command) throw new Error(`stdio server "${server.name}" has no command`)
		const env = expandEnvMap(server.env)
		// Build conditionally — the repo runs with `exactOptionalPropertyTypes`,
		// so we omit absent fields rather than passing `undefined`. Only the
		// explicitly-listed (and ${VAR}-expanded) vars reach the child; we don't
		// leak the Member's whole environment into it.
		return new StdioClientTransport({
			command: server.command,
			stderr: 'pipe',
			...(server.args ? { args: [...server.args] } : {}),
			...(env ? { env } : {}),
		}) as Transport
	}
	if (!server.url) throw new Error(`${server.transport} server "${server.name}" has no url`)
	const url = new URL(server.url)
	const headers = expandEnvMap(server.headers)
	const opts = headers ? { requestInit: { headers } } : undefined
	if (server.transport === 'sse') {
		return new SSEClientTransport(url, opts) as Transport
	}
	return new StreamableHTTPClientTransport(url, opts) as Transport
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`mcp ${label} timed out after ${ms}ms`)),
			ms,
		)
		p.then(
			(v) => {
				clearTimeout(timer)
				resolve(v)
			},
			(e) => {
				clearTimeout(timer)
				reject(e)
			},
		)
	})
}
