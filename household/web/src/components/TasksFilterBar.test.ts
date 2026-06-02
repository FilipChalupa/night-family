import { describe, expect, it } from 'vitest'
import { OPEN_STATUSES, type ReviewJobsSummary, type TaskStatus } from '../types.ts'
import { filterTasks, sameStatusSet } from './TasksFilterBar.tsx'

describe('sameStatusSet', () => {
	it('is false when nothing is selected', () => {
		expect(sameStatusSet(null, OPEN_STATUSES)).toBe(false)
	})

	it('is false on a length mismatch (subset or superset)', () => {
		expect(sameStatusSet(['queued'], OPEN_STATUSES)).toBe(false)
		expect(sameStatusSet([...OPEN_STATUSES, 'done'], OPEN_STATUSES)).toBe(false)
	})

	it('is order-insensitive', () => {
		const shuffled: TaskStatus[] = [
			'awaiting-merge',
			'queued',
			'in-review',
			'assigned',
			'in-progress',
		]
		expect(sameStatusSet(shuffled, OPEN_STATUSES)).toBe(true)
	})

	it('is false when the same length holds different members', () => {
		const sameLengthDifferent: TaskStatus[] = [
			'queued',
			'assigned',
			'in-progress',
			'in-review',
			'done', // swapped awaiting-merge -> done
		]
		expect(sameStatusSet(sameLengthDifferent, OPEN_STATUSES)).toBe(false)
	})
})

interface TestTask {
	title: string
	description: string
	repo: string | null
	status: TaskStatus
	reviewJobs: ReviewJobsSummary | null
}

const done: ReviewJobsSummary = { pending: 0, inProgress: 0, completed: 1, failed: 0 }

const task = (partial: Partial<TestTask>): TestTask => ({
	title: 'Title',
	description: 'Description',
	repo: 'org/repo',
	status: 'queued',
	reviewJobs: null,
	...partial,
})

describe('filterTasks', () => {
	const tasks: TestTask[] = [
		task({ title: 'Fix login', status: 'queued', repo: 'org/auth' }),
		task({ title: 'Add charts', status: 'in-progress', repo: 'org/web' }),
		task({ title: 'Review PR', status: 'in-review', reviewJobs: done }),
		task({ title: 'Merge me', status: 'awaiting-merge' }),
		task({ title: 'Old task', status: 'done', description: 'shipped charts' }),
	]

	it('returns everything when there is no filter', () => {
		expect(filterTasks(tasks, '', null, null)).toHaveLength(tasks.length)
	})

	it('filters by the status whitelist', () => {
		const out = filterTasks(tasks, '', ['queued', 'in-progress'], null)
		expect(out.map((t) => t.title)).toEqual(['Fix login', 'Add charts'])
	})

	it('matches the text query against title, description and repo, case-insensitively', () => {
		expect(filterTasks(tasks, 'LOGIN', null, null).map((t) => t.title)).toEqual(['Fix login'])
		// description hit
		expect(filterTasks(tasks, 'shipped', null, null).map((t) => t.title)).toEqual(['Old task'])
		// repo hit
		expect(filterTasks(tasks, 'org/web', null, null).map((t) => t.title)).toEqual([
			'Add charts',
		])
	})

	it('trims the query and treats whitespace-only as no text filter', () => {
		expect(filterTasks(tasks, '   ', null, null)).toHaveLength(tasks.length)
		expect(filterTasks(tasks, '  login  ', null, null).map((t) => t.title)).toEqual([
			'Fix login',
		])
	})

	it('keeps only tasks waiting on a human when waiting=human', () => {
		expect(filterTasks(tasks, '', null, 'human').map((t) => t.title)).toEqual([
			'Review PR',
			'Merge me',
		])
	})

	it('ANDs the waiting filter with the status filter', () => {
		// in-review IS waiting-on-human here, awaiting-merge is excluded by status.
		expect(filterTasks(tasks, '', ['in-review'], 'human').map((t) => t.title)).toEqual([
			'Review PR',
		])
		// Status that can never be waiting-on-human => empty.
		expect(filterTasks(tasks, '', ['queued'], 'human')).toEqual([])
	})
})
