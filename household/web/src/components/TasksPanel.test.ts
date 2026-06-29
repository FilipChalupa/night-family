import { describe, expect, it } from 'vitest'
import type { MemberSnapshot, TaskRecord } from '../types.ts'
import { isQueueBlockedByRepo } from './TasksPanel.tsx'

const task = (over: Partial<TaskRecord> = {}): TaskRecord =>
	({ status: 'queued', repo: 'o/r', kind: 'implement', ...over }) as TaskRecord

const member = (over: Partial<MemberSnapshot>): MemberSnapshot =>
	({ status: 'idle', skills: ['implement'], repos: null, ...over }) as MemberSnapshot

describe('isQueueBlockedByRepo', () => {
	it('is blocked when no skill-matching member covers the repo', () => {
		expect(isQueueBlockedByRepo(task(), [member({ repos: ['other/repo'] })])).toBe(true)
	})

	it('is not blocked when a member covers the repo (or is unconstrained)', () => {
		expect(isQueueBlockedByRepo(task(), [member({ repos: ['o/r'] })])).toBe(false)
		expect(isQueueBlockedByRepo(task(), [member({ repos: null })])).toBe(false)
	})

	it('only an online, skill-matching member counts', () => {
		// An online member that doesn't cover it, while the covering member is
		// offline → blocked (the offline one doesn't count).
		expect(
			isQueueBlockedByRepo(task(), [
				member({ status: 'idle', repos: ['other/x'] }),
				member({ status: 'offline', repos: ['o/r'] }),
			]),
		).toBe(true)
		// No online member can do `implement` at all → not flagged as repo-blocked
		// (that's a "no worker" state, not a repo-coverage gap).
		expect(isQueueBlockedByRepo(task(), [member({ skills: ['review'] })])).toBe(false)
		expect(isQueueBlockedByRepo(task(), [member({ status: 'offline', repos: ['o/r'] })])).toBe(
			false,
		)
	})

	it('only applies to queued repo tasks', () => {
		expect(
			isQueueBlockedByRepo(task({ status: 'in-progress' }), [member({ repos: ['x/y'] })]),
		).toBe(false)
		expect(isQueueBlockedByRepo(task({ repo: null }), [member({ repos: ['x/y'] })])).toBe(false)
	})
})
