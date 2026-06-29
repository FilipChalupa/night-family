import { describe, expect, it } from 'vitest'
import { cumulative, formatDuration, formatTokens } from './format.ts'

describe('formatTokens', () => {
	it('abbreviates thousands and millions', () => {
		expect(formatTokens(1_500)).toBe('1.5k')
		expect(formatTokens(2_300_000)).toBe('2.3M')
	})

	it('leaves small counts as a locale string and maps null to empty', () => {
		expect(formatTokens(847)).toBe('847')
		expect(formatTokens(null)).toBe('')
	})
})

describe('formatDuration', () => {
	it('renders seconds, minutes, and hours', () => {
		expect(formatDuration(45)).toBe('45s')
		expect(formatDuration(192)).toBe('3m 12s')
		expect(formatDuration(3_900)).toBe('1h 5m')
	})
})

describe('cumulative', () => {
	it('produces running totals', () => {
		expect(cumulative([1, 2, 3, 4])).toEqual([1, 3, 6, 10])
		expect(cumulative([])).toEqual([])
	})
})
