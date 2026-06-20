import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../tasks/store.ts'
import { resolvePreviewRedirect } from './proxy.ts'

function task(partial: Partial<TaskRecord>): TaskRecord {
	return {
		id: 't1',
		repo: 'o/r',
		kind: 'preview',
		title: 'preview',
		description: '',
		status: 'in-progress',
		metadata: null,
		...partial,
	} as TaskRecord
}

describe('resolvePreviewRedirect', () => {
	it('redirects an active preview to its target', () => {
		const r = resolvePreviewRedirect(
			task({
				metadata: {
					preview_target: 'http://localhost:4321',
					preview_url: 'http://h/previews/t1',
				},
			}),
		)
		expect(r).toEqual({ kind: 'redirect', location: 'http://localhost:4321' })
	})

	it('falls back to preview_url when no separate target is recorded (local mode)', () => {
		const r = resolvePreviewRedirect(
			task({ metadata: { preview_url: 'http://localhost:4321' } }),
		)
		expect(r).toEqual({ kind: 'redirect', location: 'http://localhost:4321' })
	})

	it('reports not_found for a missing task', () => {
		expect(resolvePreviewRedirect(null)).toEqual({ kind: 'not_found' })
	})

	it('reports gone once the task is no longer active', () => {
		expect(
			resolvePreviewRedirect(
				task({ status: 'done', metadata: { preview_target: 'http://x' } }),
			),
		).toEqual({ kind: 'gone' })
	})

	it('reports not_ready for an active task that has not reported a URL yet', () => {
		expect(
			resolvePreviewRedirect(task({ status: 'assigned', metadata: { branch: 'x' } })),
		).toEqual({ kind: 'not_ready' })
	})
})
