import { describe, expect, it } from 'vitest'
import {
	OPEN_STATUSES,
	isWaitingOnHuman,
	reviewWaitState,
	type ReviewJobsSummary,
	type TaskStatus,
} from './types.ts'

const jobs = (partial: Partial<ReviewJobsSummary>): ReviewJobsSummary => ({
	pending: 0,
	inProgress: 0,
	completed: 0,
	failed: 0,
	...partial,
})

describe('OPEN_STATUSES', () => {
	it('is exactly the non-terminal lifecycle statuses', () => {
		expect([...OPEN_STATUSES]).toEqual([
			'queued',
			'assigned',
			'in-progress',
			'in-review',
			'awaiting-merge',
		])
	})

	it('excludes the terminal statuses', () => {
		expect(OPEN_STATUSES.includes('done')).toBe(false)
		expect(OPEN_STATUSES.includes('failed')).toBe(false)
	})
})

describe('reviewWaitState', () => {
	it('is unknown with no jobs', () => {
		expect(reviewWaitState(null)).toBe('unknown')
		expect(reviewWaitState(jobs({}))).toBe('unknown')
	})

	it('is agent while any job is pending or in progress', () => {
		expect(reviewWaitState(jobs({ pending: 1 }))).toBe('agent')
		expect(reviewWaitState(jobs({ inProgress: 1, completed: 3 }))).toBe('agent')
	})

	it('is human once every job has finished', () => {
		expect(reviewWaitState(jobs({ completed: 2 }))).toBe('human')
		expect(reviewWaitState(jobs({ failed: 1 }))).toBe('human')
	})
})

describe('isWaitingOnHuman', () => {
	it('is true for awaiting-merge regardless of review jobs', () => {
		expect(isWaitingOnHuman({ status: 'awaiting-merge', reviewJobs: null })).toBe(true)
		expect(
			isWaitingOnHuman({ status: 'awaiting-merge', reviewJobs: jobs({ pending: 5 }) }),
		).toBe(true)
	})

	it('is true for in-review only once the agent has finished reviewing', () => {
		expect(isWaitingOnHuman({ status: 'in-review', reviewJobs: jobs({ completed: 1 }) })).toBe(
			true,
		)
		expect(isWaitingOnHuman({ status: 'in-review', reviewJobs: jobs({ failed: 1 }) })).toBe(
			true,
		)
	})

	it('is false for in-review while the agent is still reviewing or has no jobs yet', () => {
		expect(isWaitingOnHuman({ status: 'in-review', reviewJobs: jobs({ inProgress: 1 }) })).toBe(
			false,
		)
		// `unknown` (no review jobs recorded yet) counts as the agent's side.
		expect(isWaitingOnHuman({ status: 'in-review', reviewJobs: null })).toBe(false)
	})

	it('is false for every other status', () => {
		const others: TaskStatus[] = ['queued', 'assigned', 'in-progress', 'done', 'failed']
		for (const status of others) {
			expect(isWaitingOnHuman({ status, reviewJobs: jobs({ completed: 1 }) })).toBe(false)
		}
	})
})
