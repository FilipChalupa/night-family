import { describe, expect, it } from 'vitest'
import {
	appendAttribution,
	buildAttributionFooter,
	buildAttributionMarker,
	findAttributionMarker,
} from './attribution.ts'

const ATTR = {
	memberName: 'octo',
	memberId: 'm-123',
	taskId: 'abcdef0123456789',
	householdUrl: 'https://night.example.com',
}

describe('buildAttributionFooter', () => {
	it('renders a single Markdown line linking the member and the task', () => {
		const footer = buildAttributionFooter(ATTR)
		expect(footer).toBe(
			'🤖 Authored by Night Family member [`octo`](https://night.example.com/members/m-123) · task [`abcdef01`](https://night.example.com/tasks/abcdef0123456789)',
		)
		expect(footer.split('\n')).toHaveLength(1)
	})

	it('strips a trailing slash from householdUrl', () => {
		const footer = buildAttributionFooter({
			...ATTR,
			householdUrl: 'https://night.example.com/',
		})
		expect(footer).not.toContain('.com//')
	})

	it('encodes member and task ids in URLs', () => {
		const footer = buildAttributionFooter({
			...ATTR,
			memberId: 'm 1/with weird',
			taskId: 't?1',
		})
		expect(footer).toContain('/members/m%201%2Fwith%20weird')
		expect(footer).toContain('/tasks/t%3F1')
	})
})

describe('buildAttributionMarker / findAttributionMarker', () => {
	it('round-trips via the regex parser', () => {
		const marker = buildAttributionMarker({ memberId: 'm-123', taskId: 't-456' })
		expect(marker).toBe('<!-- night-family:member=m-123 task=t-456 -->')
		const parsed = findAttributionMarker(`hello\n${marker}\nbye`)
		expect(parsed).toEqual({ memberId: 'm-123', taskId: 't-456' })
	})

	it('returns null when marker is absent', () => {
		expect(findAttributionMarker('plain comment')).toBeNull()
	})
})

describe('appendAttribution', () => {
	it('appends footer + marker separated by a horizontal rule', () => {
		const out = appendAttribution('hello world', ATTR)
		expect(out).toContain('hello world')
		expect(out).toContain('---')
		expect(out).toContain('🤖 Authored by Night Family member')
		expect(out).toContain('<!-- night-family:member=m-123 task=abcdef0123456789 -->')
		// Marker should land on its own line.
		expect(out.split('\n').some((l) => l.startsWith('<!-- night-family'))).toBe(true)
	})

	it('is idempotent — calling twice does not duplicate the block', () => {
		const once = appendAttribution('hello', ATTR)
		const twice = appendAttribution(once, ATTR)
		expect(twice).toBe(once)
	})

	it('trims trailing whitespace before appending', () => {
		const out = appendAttribution('hello\n\n\n', ATTR)
		expect(out.startsWith('hello\n\n---\n')).toBe(true)
	})
})
