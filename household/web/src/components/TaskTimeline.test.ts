import { describe, expect, it } from 'vitest'
import type { TaskLogEvent } from '../types.ts'
import { kindMeta, summarizeEvent } from './TaskTimeline.tsx'

function ev(kind: string, payload: unknown): TaskLogEvent {
	return { seq: 1, ts: '2026-01-01T00:00:00.000Z', kind, memberId: null, payload }
}

describe('summarizeEvent', () => {
	it('shows a tool call with its salient arg', () => {
		expect(
			summarizeEvent(ev('tool_call', { tool: 'bash', input: { command: 'npm test' } })),
		).toEqual({ summary: 'bash(npm test)' })
		expect(
			summarizeEvent(ev('tool_call', { tool: 'read_file', input: { path: 'src/x.ts' } }))
				.summary,
		).toBe('read_file(src/x.ts)')
	})

	it('formats usage tokens (with cache when present)', () => {
		expect(summarizeEvent(ev('usage', { input: 1200, output: 3400 })).summary).toBe(
			'1.2k in · 3.4k out',
		)
		expect(
			summarizeEvent(ev('usage', { input: 1000, output: 0, cacheRead: 5000 })).summary,
		).toContain('5.0k cache')
	})

	it('flags an error log with the error tone', () => {
		const out = summarizeEvent(ev('log', { message: 'push failed', isError: true }))
		expect(out).toEqual({ summary: 'push failed', tone: 'error' })
	})

	it('summarizes commit, edit, and falls back to JSON for unknown kinds', () => {
		expect(summarizeEvent(ev('commit', { sha: 'abcdef1234', branch: 'pr/x' })).summary).toBe(
			'abcdef1 on pr/x',
		)
		expect(summarizeEvent(ev('file_edited', { path: 'a/b.ts' })).summary).toBe('a/b.ts')
		expect(summarizeEvent(ev('mystery', { foo: 1 })).summary).toBe('{"foo":1}')
	})
})

describe('kindMeta', () => {
	it('maps known kinds to a label + colour and falls back to the raw kind', () => {
		expect(kindMeta('tool_call')).toEqual({ label: 'tool', color: 'info' })
		expect(kindMeta('commit').color).toBe('success')
		expect(kindMeta('whatever')).toEqual({ label: 'whatever', color: 'default' })
	})
})
