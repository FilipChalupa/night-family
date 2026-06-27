/**
 * MCP runtime — connects to the configured MCP servers and exposes their tools
 * as ordinary {@link ToolDefinition}s, so the existing provider adapters
 * (Anthropic / Gemini / OpenAI) pick them up unchanged.
 *
 * Design notes:
 *   - A server that fails to connect (down, bad token, slow spawn) is logged
 *     and left `down`. MCP is an enhancement, never a hard dependency of task
 *     execution — a broken Slack server must not stop the Member implementing
 *     code.
 *   - Liveness: the manager keeps every configured server alive. It detects a
 *     dropped connection two ways — the transport's `onclose` (immediate, e.g.
 *     a stdio subprocess exits) and a periodic `ping` health check (catches a
 *     silently-dead HTTP server) — and reconnects down servers with backoff.
 *     Status transitions fire `onChange` so the Member can report them to
 *     Household.
 *   - Tools are namespaced `mcp__<server>__<tool>` so two servers can expose a
 *     `search` without colliding, and the name stays within the
 *     `^[a-zA-Z0-9_-]{1,128}$` shape every provider requires.
 *   - The `allow` list (read-only by default) is applied here, before the
 *     agent ever sees a tool — defense in depth on top of scoping the upstream
 *     token.
 *   - Connections are shared across every task this Member runs; the tools talk
 *     to external services, not the per-task workspace. Because reconnects can
 *     swap the live tool set, consumers must read {@link McpManager.tools}
 *     per task rather than snapshot it once.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { redactBashOutput, type McpServerInfo } from '@night/shared'
import type { Logger } from 'pino'
import { expandEnvMap, type McpServerConfig } from './mcp-config.ts'
import type { ToolDefinition, ToolResult } from './types.ts'

/** How long a single server gets to connect + list tools before we give up. */
const CONNECT_TIMEOUT_MS = 20_000
/** How long a health-check ping may hang before the server is treated as down. */
const PING_TIMEOUT_MS = 10_000
/** Default interval between health-check / reconnect passes. */
const DEFAULT_TICK_MS = 30_000
/** Reconnect backoff by consecutive-failure count (ms), clamped to the last. */
const RECONNECT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000]
/** Per call cap, so a chatty MCP tool can't blow the context budget. */
const MAX_OUTPUT_CHARS = 60_000

/** The slice of the MCP client this module actually uses — keeps tests honest. */
export interface McpToolCaller {
	callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>
}

/**
 * The client surface the manager drives. The SDK `Client` satisfies it; tests
 * provide a fake so the lifecycle (status, reconnect, health check) is testable
 * without real transports.
 */
export interface McpClient extends McpToolCaller {
	ping(): Promise<unknown>
	close(): Promise<void>
	/** Invoked by the transport when the connection drops. Assigned by the manager. */
	onclose?: (() => void) | undefined
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

/** A freshly-established connection: the live client plus its wrapped tools. */
export interface McpConnection {
	client: McpClient
	tools: ToolDefinition[]
}

/**
 * Establishes one connection. Injectable so tests can drive connect
 * success/failure (and `onclose`) without spawning real servers; the default
 * uses the MCP SDK.
 */
export type McpConnector = (server: McpServerConfig) => Promise<McpConnection>

interface ServerState {
	readonly config: McpServerConfig
	status: 'live' | 'down'
	client: McpClient | null
	tools: ToolDefinition[]
	/** Consecutive failed (re)connects — drives the backoff. */
	failures: number
	/** Earliest epoch-ms at which a down server may be retried. */
	nextAttemptAt: number
}

export interface McpManagerOptions {
	/** Override the connection establishment (tests). */
	connector?: McpConnector
	/** Health-check / reconnect interval. Default {@link DEFAULT_TICK_MS}. */
	tickMs?: number
	/** Clock seam for backoff gating (tests). Default `Date.now`. */
	clock?: () => number
}

/**
 * Owns the live MCP connections for a Member, keeping each configured server
 * connected (reconnecting dropped ones) and reporting status transitions.
 *
 * Lifecycle: {@link start} once, read {@link tools} per task, {@link close} on
 * shutdown. {@link healthCheck} runs one ping+reconnect pass; the internal
 * timer calls it on an interval, and tests call it directly.
 */
export class McpManager {
	private readonly states: ServerState[]
	private readonly connector: McpConnector
	private readonly tickMs: number
	private readonly clock: () => number
	private onChange: ((infos: McpServerInfo[]) => void) | null = null
	private lastEmitted: string | null = null
	private tickTimer: NodeJS.Timeout | null = null
	private closed = false

	constructor(
		servers: readonly McpServerConfig[],
		private readonly logger: Logger,
		opts: McpManagerOptions = {},
	) {
		this.states = servers
			.filter((s) => !s.disabled)
			.map((config) => ({
				config,
				status: 'down' as const,
				client: null,
				tools: [],
				failures: 0,
				nextAttemptAt: 0,
			}))
		this.connector = opts.connector ?? defaultConnector
		this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
		this.clock = opts.clock ?? Date.now
	}

	/** Whether any server is configured at all (skip the machinery if not). */
	get configured(): boolean {
		return this.states.length > 0
	}

	/** Live tools across every connected server. Re-read per task — it changes on reconnect. */
	get tools(): ToolDefinition[] {
		return this.states.flatMap((s) => s.tools)
	}

	/** Names of currently-live servers, for the system-prompt hint. */
	get connectedServers(): string[] {
		return this.states.filter((s) => s.status === 'live').map((s) => s.config.name)
	}

	/** Every configured server with its current status + tool count, for Household. */
	get serverInfos(): McpServerInfo[] {
		return this.states.map((s) => ({
			name: s.config.name,
			status: s.status,
			tool_count: s.tools.length,
		}))
	}

	/** Register the status-change callback (Member → Household push). */
	setOnChange(cb: (infos: McpServerInfo[]) => void): void {
		this.onChange = cb
	}

	/** Connect every server once, then start the health/reconnect loop. Never throws. */
	async start(): Promise<void> {
		if (!this.configured) return
		await Promise.all(this.states.map((s) => this.tryConnect(s)))
		this.logger.info(
			{ servers: this.connectedServers, configured: this.states.length },
			'mcp started',
		)
		// Seed `lastEmitted` so the first real change (not the initial snapshot,
		// which the handshake already carries) is what fires onChange.
		this.lastEmitted = JSON.stringify(this.serverInfos)
		this.scheduleTick()
	}

	/**
	 * One health-check + reconnect pass: ping live servers (a failure means the
	 * connection is dead), and retry down servers whose backoff has elapsed.
	 * Public so the timer and tests share one path.
	 */
	async healthCheck(): Promise<void> {
		if (this.closed) return
		const now = this.clock()
		await Promise.all(
			this.states.map(async (state) => {
				if (state.status === 'live') {
					try {
						await withTimeout(state.client!.ping(), PING_TIMEOUT_MS, 'ping')
					} catch {
						this.markDown(state, 'ping failed')
					}
				} else if (now >= state.nextAttemptAt) {
					await this.tryConnect(state)
				}
			}),
		)
		this.emitIfChanged()
	}

	private async tryConnect(state: ServerState): Promise<void> {
		const log = this.logger.child({ mcpServer: state.config.name })
		try {
			const conn = await this.connector(state.config)
			state.client = conn.client
			state.tools = conn.tools
			state.status = 'live'
			state.failures = 0
			// Immediate down-detection: the transport tells us when it drops.
			conn.client.onclose = () => this.handleClose(state)
			log.info({ tools: conn.tools.length }, 'mcp server live')
		} catch (err) {
			state.client = null
			state.tools = []
			state.status = 'down'
			state.failures += 1
			state.nextAttemptAt = this.clock() + backoff(state.failures)
			log.warn({ err, failures: state.failures }, 'mcp server down — will retry')
		}
	}

	/** onclose handler — flip to down immediately and let the next tick reconnect. */
	private handleClose(state: ServerState): void {
		if (this.closed || state.status !== 'live') return
		this.logger.child({ mcpServer: state.config.name }).warn('mcp connection closed')
		this.markDown(state, 'connection closed')
		this.emitIfChanged()
	}

	private markDown(state: ServerState, _reason: string): void {
		state.status = 'down'
		state.client = null
		state.tools = []
		// Don't count an onclose as a connect failure (failures drives connect
		// backoff); just gate the next retry by the current step.
		state.nextAttemptAt = this.clock() + backoff(state.failures + 1)
	}

	private scheduleTick(): void {
		if (this.closed) return
		this.tickTimer = setTimeout(() => {
			void this.healthCheck().finally(() => this.scheduleTick())
		}, this.tickMs)
		this.tickTimer.unref?.()
	}

	private emitIfChanged(): void {
		const infos = this.serverInfos
		const key = JSON.stringify(infos)
		if (key === this.lastEmitted) return
		this.lastEmitted = key
		this.onChange?.(infos)
	}

	/** Stop the loop and close every connection. Best-effort. */
	async close(): Promise<void> {
		this.closed = true
		if (this.tickTimer) clearTimeout(this.tickTimer)
		this.tickTimer = null
		await Promise.all(
			this.states.map(async (state) => {
				const client = state.client
				state.client = null
				state.status = 'down'
				state.tools = []
				if (!client) return
				client.onclose = undefined
				try {
					await client.close()
				} catch {
					// already gone / process exiting — nothing useful to do
				}
			}),
		)
	}
}

/** Backoff for the Nth consecutive failure (1-indexed), clamped to the last step. */
function backoff(failures: number): number {
	const i = Math.min(Math.max(failures, 1), RECONNECT_BACKOFF_MS.length) - 1
	return RECONNECT_BACKOFF_MS[i]!
}

const defaultConnector: McpConnector = async (server) => {
	const transport = buildTransport(server)
	const client = new Client({ name: 'night-family-member', version: '0.0.0' })
	try {
		await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'connect')
		const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'listTools')
		const allow = server.allow == null ? null : new Set(server.allow)
		const tools: ToolDefinition[] = []
		for (const descriptor of listed.tools as McpToolDescriptor[]) {
			if (allow && !allow.has(descriptor.name)) continue
			tools.push(wrapMcpTool(server.name, descriptor, client))
		}
		return { client: client as unknown as McpClient, tools }
	} catch (err) {
		try {
			await client.close()
		} catch {
			// best-effort cleanup of a half-open client
		}
		throw err
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
