import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import {
	McpManager,
	wrapMcpTool,
	type McpClient,
	type McpConnection,
	type McpConnector,
	type McpToolCaller,
} from './mcp.ts'
import type { McpServerConfig } from './mcp-config.ts'

function caller(impl: McpToolCaller['callTool']): McpToolCaller {
	return { callTool: impl }
}

const silent = pino({ level: 'silent' })

describe('wrapMcpTool', () => {
	const descriptor = {
		name: 'get_issue',
		description: 'Fetch an issue',
		inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
	}

	it('namespaces the tool and preserves the schema', () => {
		const tool = wrapMcpTool(
			'linear',
			descriptor,
			caller(async () => ({ content: [] })),
		)
		expect(tool.name).toBe('mcp__linear__get_issue')
		expect(tool.description).toContain('via linear MCP')
		expect(tool.inputSchema).toEqual(descriptor.inputSchema)
	})

	it('sanitizes names to the provider-allowed shape and caps length', () => {
		const tool = wrapMcpTool(
			'my server',
			{ name: 'do.it!' },
			caller(async () => ({})),
		)
		expect(tool.name).toBe('mcp__my_server__do_it_')
		expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/)
	})

	it('falls back to a permissive object schema when none is advertised', () => {
		const tool = wrapMcpTool(
			'x',
			{ name: 't' },
			caller(async () => ({})),
		)
		expect(tool.inputSchema).toEqual({ type: 'object', properties: {} })
	})

	it('forwards the input as arguments and joins text content', async () => {
		const spy = vi.fn(async () => ({
			content: [
				{ type: 'text', text: 'line 1' },
				{ type: 'text', text: 'line 2' },
			],
		}))
		const tool = wrapMcpTool('linear', descriptor, caller(spy))
		const result = await tool.run({ id: 'ABC-1' })
		expect(spy).toHaveBeenCalledWith(
			{ name: 'get_issue', arguments: { id: 'ABC-1' } },
			{ timeout: 120_000 },
		)
		expect(result.output).toBe('line 1\nline 2')
		expect(result.isError).toBe(false)
	})

	it('notes non-text content blocks instead of dumping them', async () => {
		const tool = wrapMcpTool(
			'x',
			{ name: 't' },
			caller(async () => ({
				content: [
					{ type: 'image', data: 'base64…' },
					{ type: 'resource', resource: { uri: 'file:///doc' } },
				],
			})),
		)
		const result = await tool.run({})
		expect(result.output).toContain('[image content omitted]')
		expect(result.output).toContain('[resource: file:///doc]')
	})

	it('flags an MCP-reported error and gives empty output a placeholder', async () => {
		const tool = wrapMcpTool(
			'x',
			{ name: 't' },
			caller(async () => ({ isError: true, content: [] })),
		)
		const result = await tool.run({})
		expect(result.isError).toBe(true)
		expect(result.output).toContain('error')
	})

	it('turns a thrown call into a tool error rather than crashing the loop', async () => {
		const tool = wrapMcpTool(
			'slack',
			{ name: 'post' },
			caller(async () => {
				throw new Error('connection reset')
			}),
		)
		const result = await tool.run({})
		expect(result.isError).toBe(true)
		expect(result.output).toContain('slack/post failed')
		expect(result.output).toContain('connection reset')
	})

	it('forwards a per-call timeout so the SDK cancels a hung call', async () => {
		const spy = vi.fn(async () => ({ content: [] }))
		const tool = wrapMcpTool('slack', { name: 'search' }, caller(spy))
		await tool.run({ q: 'x' })
		// The timeout is passed to the SDK (which cancels on expiry), not a wrapper
		// that orphans the request.
		expect(spy).toHaveBeenCalledWith(
			{ name: 'search', arguments: { q: 'x' } },
			{ timeout: 120_000 },
		)
	})

	it('coerces non-object input to empty arguments', async () => {
		const spy = vi.fn(async () => ({ content: [] }))
		const tool = wrapMcpTool('x', { name: 't' }, caller(spy))
		await tool.run('not an object')
		expect(spy).toHaveBeenCalledWith({ name: 't', arguments: {} }, { timeout: 120_000 })
	})
})

// --- McpManager lifecycle ---------------------------------------------------

/** A controllable fake client + transport for driving the manager's lifecycle. */
class FakeClient implements McpClient {
	onclose: (() => void) | undefined
	closed = false
	pingImpl: () => Promise<unknown> = async () => ({})
	async callTool() {
		return { content: [{ type: 'text', text: 'ok' }] }
	}
	async ping() {
		return this.pingImpl()
	}
	async close() {
		this.closed = true
	}
	/** Simulate the transport dropping the connection. */
	drop() {
		this.onclose?.()
	}
}

function stdioCfg(name: string, allow?: string[]): McpServerConfig {
	return { name, transport: 'stdio', command: 'x', ...(allow ? { allow } : {}) }
}

/** Connector harness: tracks the latest client per server and can be made to fail. */
function harness() {
	let fail = false
	const current = new Map<string, FakeClient>()
	const connector: McpConnector = async (server): Promise<McpConnection> => {
		if (fail) throw new Error('connect refused')
		const client = new FakeClient()
		current.set(server.name, client)
		const names = server.allow ?? ['a', 'b']
		const tools = [...names].map((n) => wrapMcpTool(server.name, { name: n }, client))
		return { client, tools }
	}
	return {
		connector,
		setFail: (v: boolean) => {
			fail = v
		},
		clientFor: (name: string) => current.get(name)!,
	}
}

describe('McpManager lifecycle', () => {
	it('connects servers at start and exposes their tools', async () => {
		const h = harness()
		const mgr = new McpManager([stdioCfg('s1', ['a', 'b'])], silent, {
			connector: h.connector,
			tickMs: 1e9,
		})
		await mgr.start()
		expect(mgr.serverInfos).toEqual([{ name: 's1', status: 'live', tool_count: 2 }])
		expect(mgr.connectedServers).toEqual(['s1'])
		expect(mgr.tools.map((t) => t.name)).toEqual(['mcp__s1__a', 'mcp__s1__b'])
		await mgr.close()
	})

	it('marks a failed server down and reconnects once its backoff elapses', async () => {
		const h = harness()
		h.setFail(true)
		let now = 0
		const mgr = new McpManager([stdioCfg('s1')], silent, {
			connector: h.connector,
			tickMs: 1e9,
			clock: () => now,
		})
		await mgr.start()
		expect(mgr.serverInfos[0]).toEqual({ name: 's1', status: 'down', tool_count: 0 })
		expect(mgr.tools).toEqual([])

		// Server recovers, but the backoff window hasn't elapsed yet.
		h.setFail(false)
		await mgr.healthCheck()
		expect(mgr.serverInfos[0]!.status).toBe('down')

		// Past the backoff → the next health check reconnects.
		now += 5_000
		await mgr.healthCheck()
		expect(mgr.serverInfos[0]!.status).toBe('live')
		expect(mgr.tools.length).toBe(2)
		await mgr.close()
	})

	it('flips to down on an onclose drop and fires onChange, then reconnects', async () => {
		const h = harness()
		let now = 0
		const mgr = new McpManager([stdioCfg('s1')], silent, {
			connector: h.connector,
			tickMs: 1e9,
			clock: () => now,
		})
		await mgr.start()
		const changes: string[][] = []
		mgr.setOnChange((infos) => changes.push(infos.map((i) => `${i.name}:${i.status}`)))

		h.clientFor('s1').drop()
		expect(mgr.serverInfos[0]!.status).toBe('down')
		expect(changes).toEqual([['s1:down']])

		now += 5_000
		await mgr.healthCheck()
		expect(mgr.serverInfos[0]!.status).toBe('live')
		expect(changes).toEqual([['s1:down'], ['s1:live']])
		await mgr.close()
	})

	it('treats a failed health-check ping as the server going down', async () => {
		const h = harness()
		const mgr = new McpManager([stdioCfg('s1')], silent, {
			connector: h.connector,
			tickMs: 1e9,
		})
		await mgr.start()
		const changes: number[] = []
		mgr.setOnChange((infos) => changes.push(infos.filter((i) => i.status === 'live').length))

		h.clientFor('s1').pingImpl = async () => {
			throw new Error('unreachable')
		}
		await mgr.healthCheck()
		expect(mgr.serverInfos[0]!.status).toBe('down')
		expect(changes).toEqual([0])
		await mgr.close()
	})

	it('does not fire onChange when nothing changed (stable pings)', async () => {
		const h = harness()
		const mgr = new McpManager([stdioCfg('s1')], silent, {
			connector: h.connector,
			tickMs: 1e9,
		})
		await mgr.start()
		const changes: unknown[] = []
		mgr.setOnChange((infos) => changes.push(infos))
		await mgr.healthCheck()
		await mgr.healthCheck()
		expect(changes).toEqual([])
		await mgr.close()
	})

	it('closes every live client on shutdown', async () => {
		const h = harness()
		const mgr = new McpManager([stdioCfg('s1')], silent, {
			connector: h.connector,
			tickMs: 1e9,
		})
		await mgr.start()
		const client = h.clientFor('s1')
		await mgr.close()
		expect(client.closed).toBe(true)
		expect(mgr.serverInfos[0]!.status).toBe('down')
	})

	it('does not resurrect a server whose connect resolves after close()', async () => {
		let resolveConn!: (c: McpConnection) => void
		const client = new FakeClient()
		const connector: McpConnector = () =>
			new Promise<McpConnection>((res) => {
				resolveConn = res
			})
		const mgr = new McpManager([stdioCfg('s1')], silent, { connector, tickMs: 1e9 })
		const startP = mgr.start() // tryConnect now awaits the connector
		await mgr.close() // shutdown lands before the connect resolves
		resolveConn({ client, tools: [] })
		await startP
		// The just-opened client (and its subprocess) is closed, not adopted.
		expect(client.closed).toBe(true)
		expect(mgr.serverInfos[0]!.status).toBe('down')
	})

	it('escalates reconnect backoff for a flapping server (no stabilizing ping)', async () => {
		const h = harness()
		let now = 0
		const mgr = new McpManager([stdioCfg('s1')], silent, {
			connector: h.connector,
			tickMs: 1e9,
			clock: () => now,
		})
		await mgr.start()

		// First drop → backoff(1) = 5s.
		h.clientFor('s1').drop()
		now = 5_000
		await mgr.healthCheck()
		expect(mgr.serverInfos[0]!.status).toBe('live')

		// Drop again before any stabilizing ping → backoff escalates to 15s, so a
		// reconnect at +5s is too early; +15s reconnects.
		h.clientFor('s1').drop()
		now = 5_000 + 5_000
		await mgr.healthCheck()
		expect(mgr.serverInfos[0]!.status).toBe('down')
		now = 5_000 + 15_000
		await mgr.healthCheck()
		expect(mgr.serverInfos[0]!.status).toBe('live')
		await mgr.close()
	})

	it('is inert with no servers configured', async () => {
		const mgr = new McpManager([], silent, { tickMs: 1e9 })
		expect(mgr.configured).toBe(false)
		await mgr.start()
		expect(mgr.tools).toEqual([])
		expect(mgr.serverInfos).toEqual([])
		await mgr.close()
	})
})
