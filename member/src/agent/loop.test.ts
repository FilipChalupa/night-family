import { describe, expect, it } from 'vitest'
import { executeToolCall, throwIfAborted } from './loop.ts'
import type { AgentEvent, ToolDefinition } from './types.ts'

function tool(name: string, run: ToolDefinition['run']): ToolDefinition {
	return { name, description: name, inputSchema: {}, run }
}

function collector() {
	const events: AgentEvent[] = []
	return { events, onEvent: (e: AgentEvent) => void events.push(e) }
}

describe('throwIfAborted', () => {
	it('does nothing when the signal has not fired', () => {
		expect(() => throwIfAborted(new AbortController().signal)).not.toThrow()
	})

	it('throws an AbortError (by name) so the runner can tell cancel from crash', () => {
		const ac = new AbortController()
		ac.abort()
		try {
			throwIfAborted(ac.signal)
			expect.unreachable('should have thrown')
		} catch (err) {
			expect((err as Error).name).toBe('AbortError')
		}
	})
})

describe('executeToolCall', () => {
	it('runs the tool and emits tool_call then log', async () => {
		const map = new Map([
			['echo', tool('echo', async (i) => ({ output: `ran ${JSON.stringify(i)}` }))],
		])
		const { events, onEvent } = collector()

		const outcome = await executeToolCall(map, 'echo', { a: 1 }, onEvent)

		expect(outcome).toEqual({ output: 'ran {"a":1}', isError: false })
		expect(events.map((e) => e.kind)).toEqual(['tool_call', 'log'])
		expect(events[0]!.payload).toEqual({ tool: 'echo', input: { a: 1 } })
	})

	it('reports an unknown tool as an error without throwing', async () => {
		const { events, onEvent } = collector()

		const outcome = await executeToolCall(new Map(), 'nope', {}, onEvent)

		expect(outcome.isError).toBe(true)
		expect(outcome.output).toBe('unknown tool: nope')
		// Both events still fire so the unknown call is visible in the task log.
		expect(events.map((e) => e.kind)).toEqual(['tool_call', 'log'])
	})

	it('catches a thrown tool error and surfaces its message', async () => {
		const map = new Map([
			[
				'boom',
				tool('boom', async () => {
					throw new Error('kaboom')
				}),
			],
		])
		const { onEvent } = collector()

		const outcome = await executeToolCall(map, 'boom', {}, onEvent)

		expect(outcome).toEqual({ output: 'kaboom', isError: true })
	})

	it('honours an explicit isError from the tool result', async () => {
		const map = new Map([
			['warn', tool('warn', async () => ({ output: 'nope', isError: true }))],
		])
		const { onEvent } = collector()

		const outcome = await executeToolCall(map, 'warn', {}, onEvent)

		expect(outcome).toEqual({ output: 'nope', isError: true })
	})

	it('truncates the logged output to 800 chars but returns it in full', async () => {
		const big = 'x'.repeat(2000)
		const map = new Map([['big', tool('big', async () => ({ output: big }))]])
		const { events, onEvent } = collector()

		const outcome = await executeToolCall(map, 'big', {}, onEvent)

		expect(outcome.output).toHaveLength(2000)
		const logPayload = events[1]!.payload as { output: string }
		expect(logPayload.output).toHaveLength(800)
	})
})
