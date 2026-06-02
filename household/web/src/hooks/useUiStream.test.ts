import { describe, expect, it } from 'vitest'
import type { MemberSnapshot } from '../types.ts'
import { dedupeByMember, upsertMemberSession } from './useUiStream.ts'

const member = (partial: Partial<MemberSnapshot>): MemberSnapshot => ({
	sessionId: 'sess-1',
	memberId: 'member-1',
	memberName: 'kira',
	displayName: 'Kira',
	skills: [],
	fullSkills: [],
	schedule: null,
	scheduleStatus: null,
	override: null,
	repos: null,
	provider: 'openai',
	model: 'gpt-5-codex',
	workerProfile: 'medium',
	protocolVersion: '3.1.0',
	tokenId: 'token-1',
	connectedAt: '2026-01-01T00:00:00.000Z',
	firstConnectedAt: '2026-01-01T00:00:00.000Z',
	status: 'idle',
	currentTask: null,
	lastHeartbeat: '2026-01-01T00:00:00.000Z',
	lastReposError: null,
	...partial,
})

describe('dedupeByMember', () => {
	it('passes a lone online member through with a count of 1', () => {
		const out = dedupeByMember([member({})])
		expect(out).toHaveLength(1)
		expect(out[0]?.onlineSessionCount).toBe(1)
		expect(out[0]?.status).toBe('idle')
	})

	it('collapses an offline shell left over from a reconnect (the duplicate-row bug)', () => {
		// Same memberId, two sessionIds: the dead one marked offline, the fresh
		// one live. This is exactly what a host restart produces.
		const out = dedupeByMember([
			member({
				sessionId: 'old',
				status: 'offline',
				connectedAt: '2026-01-01T00:00:00.000Z',
			}),
			member({ sessionId: 'new', status: 'idle', connectedAt: '2026-01-01T00:10:00.000Z' }),
		])
		expect(out).toHaveLength(1)
		expect(out[0]?.sessionId).toBe('new')
		expect(out[0]?.status).toBe('idle')
		expect(out[0]?.onlineSessionCount).toBe(1)
	})

	it('flags multiple concurrent online sessions and picks the most recent as representative', () => {
		const out = dedupeByMember([
			member({ sessionId: 'a', status: 'idle', connectedAt: '2026-01-01T00:00:00.000Z' }),
			member({ sessionId: 'b', status: 'busy', connectedAt: '2026-01-01T00:05:00.000Z' }),
		])
		expect(out).toHaveLength(1)
		expect(out[0]?.onlineSessionCount).toBe(2)
		expect(out[0]?.sessionId).toBe('b') // latest connectedAt wins
	})

	it('keeps an offline-only member with a count of 0', () => {
		const out = dedupeByMember([member({ sessionId: 'gone', status: 'offline' })])
		expect(out).toHaveLength(1)
		expect(out[0]?.status).toBe('offline')
		expect(out[0]?.onlineSessionCount).toBe(0)
	})

	it('keeps distinct members separate and in first-seen order', () => {
		const out = dedupeByMember([
			member({ memberId: 'm1', sessionId: 's1' }),
			member({ memberId: 'm2', sessionId: 's2' }),
			member({ memberId: 'm1', sessionId: 's1-dup', status: 'offline' }),
		])
		expect(out.map((m) => m.memberId)).toEqual(['m1', 'm2'])
	})
})

describe('upsertMemberSession', () => {
	it('adds a brand-new session', () => {
		const out = upsertMemberSession([], member({ sessionId: 's1' }))
		expect(out).toHaveLength(1)
		expect(out[0]?.sessionId).toBe('s1')
	})

	it('updates an existing session in place (by sessionId)', () => {
		const prev = [member({ sessionId: 's1', status: 'idle' })]
		const out = upsertMemberSession(prev, member({ sessionId: 's1', status: 'busy' }))
		expect(out).toHaveLength(1)
		expect(out[0]?.status).toBe('busy')
	})

	it('drops the offline shell of a prior session when the member reconnects', () => {
		const prev = [member({ sessionId: 'old', status: 'offline' })]
		const out = upsertMemberSession(prev, member({ sessionId: 'new', status: 'idle' }))
		expect(out.map((m) => m.sessionId)).toEqual(['new'])
	})

	it('keeps another *online* session for the same member (concurrent connection)', () => {
		const prev = [member({ sessionId: 'a', status: 'idle' })]
		const out = upsertMemberSession(prev, member({ sessionId: 'b', status: 'idle' }))
		expect(out.map((m) => m.sessionId).sort()).toEqual(['a', 'b'])
	})

	it('does not touch offline shells belonging to a different member', () => {
		const prev = [member({ memberId: 'other', sessionId: 'x', status: 'offline' })]
		const out = upsertMemberSession(prev, member({ memberId: 'member-1', sessionId: 's1' }))
		expect(out.map((m) => m.sessionId).sort()).toEqual(['s1', 'x'])
	})
})
