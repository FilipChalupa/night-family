import { describe, expect, it } from 'vitest'
import { buildAttributionFooter, buildAttributionInstruction } from './attribution.ts'

describe('buildAttributionFooter', () => {
	it('renders a single Markdown line linking the member and the task', () => {
		const footer = buildAttributionFooter({
			memberName: 'octo',
			memberId: 'm-123',
			taskId: 'abcdef0123456789',
			householdUrl: 'https://night.example.com',
		})
		expect(footer).toBe(
			'🤖 Authored by Night Family member [`octo`](https://night.example.com/members/m-123) · task [`abcdef01`](https://night.example.com/tasks/abcdef0123456789)',
		)
		expect(footer.split('\n')).toHaveLength(1)
	})

	it('strips a trailing slash from householdUrl', () => {
		const footer = buildAttributionFooter({
			memberName: 'octo',
			memberId: 'm-1',
			taskId: 't-1',
			householdUrl: 'https://night.example.com/',
		})
		expect(footer).not.toContain('.com//')
		expect(footer).toContain('https://night.example.com/members/')
	})

	it('encodes member and task ids', () => {
		const footer = buildAttributionFooter({
			memberName: 'octo',
			memberId: 'm 1/with weird',
			taskId: 't?1',
			householdUrl: 'https://night.example.com',
		})
		expect(footer).toContain('/members/m%201%2Fwith%20weird')
		expect(footer).toContain('/tasks/t%3F1')
	})
})

describe('buildAttributionInstruction', () => {
	it('embeds the footer verbatim under a horizontal rule', () => {
		const footer = '🤖 hi'
		const block = buildAttributionInstruction(footer)
		expect(block).toContain(footer)
		expect(block).toContain('---')
		// Must mention both comment-posting commands so the agent applies it
		// to reviews and to plain comments.
		expect(block).toContain('gh pr review')
		expect(block).toContain('gh pr comment')
	})
})
