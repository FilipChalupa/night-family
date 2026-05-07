import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './prompts.ts'

const BASE = {
	memberName: 'octo',
	repo: 'octo/repo',
	projectInstructions: null,
}

describe('buildSystemPrompt — token budget hint', () => {
	it('omits the budget section entirely when the hint is null', () => {
		const prompt = buildSystemPrompt({ ...BASE, tokenBudgetHint: null })
		expect(prompt).not.toContain('# Token budget')
	})

	it('renders the hint verbatim under a `# Token budget` heading', () => {
		const hint = 'Token budget: ~50,000 for this task; ~120,000 remaining today.'
		const prompt = buildSystemPrompt({ ...BASE, tokenBudgetHint: hint })
		expect(prompt).toContain('# Token budget')
		expect(prompt).toContain(hint)
		// The pacing nudge ships alongside the hint so the agent knows what
		// "approaching the cap" implies in practice.
		expect(prompt).toMatch(/approaching the cap/i)
	})
})
