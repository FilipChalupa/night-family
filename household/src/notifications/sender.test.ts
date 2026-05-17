import { describe, expect, it } from 'vitest'
import { buildSlackMessage } from './sender.ts'

const TS = '2026-05-06T12:00:00.000Z'

describe('buildSlackMessage', () => {
	it('overrides webhook identity with a Night Family name and crescent moon emoji', () => {
		const msg = buildSlackMessage('test', { message: 'hi' }, TS)
		expect(msg.username).toBe('Night Family')
		expect(msg.icon_emoji).toBe(':crescent_moon:')
	})

	it('renders task.failed with danger attachment, header, and fields', () => {
		const msg = buildSlackMessage(
			'task.failed',
			{ taskId: 't-1', reason: 'agent_error', title: 'Refactor the dispatcher' },
			TS,
		)

		expect(msg.text).toBe('[Night Family] Task failed')
		expect(msg.attachments).toHaveLength(1)
		const att = msg.attachments[0]!
		expect(att.color).toBe('danger')

		const blocks = att.blocks as Array<Record<string, unknown>>
		const header = blocks.find((b) => b.type === 'header') as
			| { text: { text: string } }
			| undefined
		expect(header?.text.text).toBe('Task failed')

		const section = blocks.find((b) => b.type === 'section') as
			| { fields: Array<{ text: string }> }
			| undefined
		const fieldTexts = section?.fields.map((f) => f.text) ?? []
		expect(fieldTexts).toContain('*Task*\nRefactor the dispatcher')
		expect(fieldTexts).toContain('*Reason*\nagent_error')
		expect(fieldTexts.some((t) => t.includes('`t-1`'))).toBe(true)

		const context = blocks.find((b) => b.type === 'context') as
			| { elements: Array<{ text: string }> }
			| undefined
		expect(context?.elements[0]?.text).toContain('task.failed')
		expect(context?.elements[0]?.text).toContain(TS)
	})

	it('renders pr.merged as good with a View PR action when prUrl is present', () => {
		const msg = buildSlackMessage(
			'pr.merged',
			{ taskId: 't-2', prUrl: 'https://github.com/o/r/pull/12', title: 'Fix flaky test' },
			TS,
		)

		expect(msg.attachments[0]!.color).toBe('good')
		const blocks = msg.attachments[0]!.blocks as Array<Record<string, unknown>>
		const actions = blocks.find((b) => b.type === 'actions') as
			| { elements: Array<{ url: string; text: { text: string } }> }
			| undefined
		expect(actions?.elements[0]?.url).toBe('https://github.com/o/r/pull/12')
		expect(actions?.elements[0]?.text.text).toBe('View PR')
	})

	it('triage.result builds an Open issue button from repo + issueNumber', () => {
		const msg = buildSlackMessage(
			'triage.result',
			{
				taskId: 't-3',
				title: 'Add dark mode',
				repo: 'octo/sample',
				issueNumber: 42,
				outcome: 'plan',
				size: 'M',
			},
			TS,
		)

		expect(msg.attachments[0]!.color).toBe('good')
		const blocks = msg.attachments[0]!.blocks as Array<Record<string, unknown>>
		const header = blocks.find((b) => b.type === 'header') as
			| { text: { text: string } }
			| undefined
		expect(header?.text.text).toBe('Triage: plan')

		const section = blocks.find((b) => b.type === 'section') as
			| { fields: Array<{ text: string }> }
			| undefined
		const texts = section?.fields.map((f) => f.text) ?? []
		expect(texts.some((t) => t.includes('Issue') && t.includes('#42'))).toBe(true)
		expect(texts.some((t) => t.includes('octo/sample'))).toBe(true)

		const actions = blocks.find((b) => b.type === 'actions') as
			| { elements: Array<{ url: string }> }
			| undefined
		expect(actions?.elements[0]?.url).toBe('https://github.com/octo/sample/issues/42')
	})

	it('triage.result with question outcome is warning-colored and has no action when no repo', () => {
		const msg = buildSlackMessage(
			'triage.result',
			{ taskId: 't-4', title: 'Vague request', outcome: 'question' },
			TS,
		)
		expect(msg.attachments[0]!.color).toBe('warning')
		const blocks = msg.attachments[0]!.blocks as Array<Record<string, unknown>>
		expect(blocks.some((b) => b.type === 'actions')).toBe(false)
	})

	it('summarize.result includes the summary as a body section', () => {
		const summary = 'Three PRs landed today.\n- one\n- two\n- three'
		const msg = buildSlackMessage(
			'summarize.result',
			{ taskId: 't-5', title: 'Daily digest', summary },
			TS,
		)
		const blocks = msg.attachments[0]!.blocks as Array<Record<string, unknown>>
		const sections = blocks.filter((b) => b.type === 'section') as Array<{
			text?: { text: string }
		}>
		const body = sections.find((s) => typeof s.text?.text === 'string')
		expect(body?.text?.text).toBe(summary)
	})

	it('member.disconnected renders the session id in monospace', () => {
		const msg = buildSlackMessage(
			'member.disconnected',
			{ sessionId: '4bbbd515-223c-48bc-a0b8-4f05107d10c8' },
			TS,
		)
		expect(msg.attachments[0]!.color).toBe('warning')
		const blocks = msg.attachments[0]!.blocks as Array<Record<string, unknown>>
		const section = blocks.find((b) => b.type === 'section') as
			| { fields: Array<{ text: string }> }
			| undefined
		expect(section?.fields[0]?.text).toBe('*Session*\n`4bbbd515-223c-48bc-a0b8-4f05107d10c8`')
	})

	it('token.revoked surfaces the actor', () => {
		const msg = buildSlackMessage(
			'token.revoked',
			{ tokenId: 'tok_1', tokenName: 'gaming-pc', revokedBy: 'alice' },
			TS,
		)
		const blocks = msg.attachments[0]!.blocks as Array<Record<string, unknown>>
		const section = blocks.find((b) => b.type === 'section') as
			| { fields: Array<{ text: string }> }
			| undefined
		const texts = section?.fields.map((f) => f.text) ?? []
		expect(texts).toContain('*Token*\ngaming-pc')
		expect(texts).toContain('*Revoked by*\nalice')
	})
})
