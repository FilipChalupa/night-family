import { describe, expect, it } from 'vitest'
import { acceptableTaskKinds, compareProtocolVersions, parseProtocolVersion } from './protocol.ts'

describe('parseProtocolVersion', () => {
	it('parses a well-formed semver string', () => {
		expect(parseProtocolVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
	})

	it('parses zeros', () => {
		expect(parseProtocolVersion('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 })
	})

	it('parses multi-digit components', () => {
		expect(parseProtocolVersion('12.34.567')).toEqual({ major: 12, minor: 34, patch: 567 })
	})

	it.each(['1', '1.2', '1.2.3.4', '1.2.3-beta', 'v1.2.3', '1.2.x', '', 'abc', '1..3', '1.2.'])(
		'rejects malformed input %s',
		(raw) => {
			expect(parseProtocolVersion(raw)).toBeNull()
		},
	)
})

describe('compareProtocolVersions', () => {
	it('returns equal for identical versions', () => {
		expect(compareProtocolVersions('1.2.3', '1.2.3')).toBe('equal')
	})

	it('returns patch-skew when only patch differs', () => {
		expect(compareProtocolVersions('1.2.3', '1.2.9')).toBe('patch-skew')
		expect(compareProtocolVersions('1.2.9', '1.2.3')).toBe('patch-skew')
	})

	it('returns minor-skew when minor differs (regardless of patch)', () => {
		expect(compareProtocolVersions('1.2.3', '1.4.3')).toBe('minor-skew')
		expect(compareProtocolVersions('1.4.3', '1.2.3')).toBe('minor-skew')
		expect(compareProtocolVersions('1.2.3', '1.4.9')).toBe('minor-skew')
	})

	it('returns major-mismatch when major differs (regardless of minor/patch)', () => {
		expect(compareProtocolVersions('1.2.3', '2.2.3')).toBe('major-mismatch')
		expect(compareProtocolVersions('2.0.0', '1.99.99')).toBe('major-mismatch')
	})

	it('treats invalid input as major-mismatch', () => {
		expect(compareProtocolVersions('1.2.3', 'garbage')).toBe('major-mismatch')
		expect(compareProtocolVersions('garbage', '1.2.3')).toBe('major-mismatch')
		expect(compareProtocolVersions('1', '1.0.0')).toBe('major-mismatch')
	})
})

describe('acceptableTaskKinds', () => {
	it('expands implement skill into [implement, rebase]', () => {
		expect(acceptableTaskKinds(['implement']).sort()).toEqual(['implement', 'rebase'])
	})

	it('passes review/triage/respond/summarize through unchanged', () => {
		expect(acceptableTaskKinds(['review'])).toEqual(['review'])
		expect(acceptableTaskKinds(['triage'])).toEqual(['triage'])
		expect(acceptableTaskKinds(['respond'])).toEqual(['respond'])
		expect(acceptableTaskKinds(['summarize'])).toEqual(['summarize'])
	})

	it('combines multiple skills, deduped', () => {
		expect(acceptableTaskKinds(['implement', 'review']).sort()).toEqual([
			'implement',
			'rebase',
			'review',
		])
	})

	it('returns [] for an empty skill set', () => {
		expect(acceptableTaskKinds([])).toEqual([])
	})

	it('a member without `implement` cannot take rebase tasks', () => {
		expect(acceptableTaskKinds(['review', 'triage'])).not.toContain('rebase')
	})
})
