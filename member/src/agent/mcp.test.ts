import { describe, expect, it, vi } from 'vitest'
import { wrapMcpTool, type McpToolCaller } from './mcp.ts'

function caller(impl: McpToolCaller['callTool']): McpToolCaller {
	return { callTool: impl }
}

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
		expect(spy).toHaveBeenCalledWith({ name: 'get_issue', arguments: { id: 'ABC-1' } })
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

	it('coerces non-object input to empty arguments', async () => {
		const spy = vi.fn(async () => ({ content: [] }))
		const tool = wrapMcpTool('x', { name: 't' }, caller(spy))
		await tool.run('not an object')
		expect(spy).toHaveBeenCalledWith({ name: 't', arguments: {} })
	})
})
