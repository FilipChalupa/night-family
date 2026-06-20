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

const port = (p: number, label: string, url: string, target = url) => ({
	port: p,
	label,
	url,
	target,
})

describe('resolvePreviewRedirect', () => {
	it('redirects an active preview to its primary port target', () => {
		const r = resolvePreviewRedirect(
			task({
				metadata: {
					preview_ports: [
						port(4321, 'app', 'http://h/previews/t1', 'http://localhost:4321'),
					],
				},
			}),
		)
		expect(r).toEqual({ kind: 'redirect', location: 'http://localhost:4321' })
	})

	it('redirects to a specific port when one is requested', () => {
		const t = task({
			metadata: {
				preview_ports: [
					port(5173, 'web', 'http://h/previews/t1', 'http://localhost:5173'),
					port(3000, 'api', 'http://h/previews/t1/3000', 'http://localhost:3000'),
				],
			},
		})
		expect(resolvePreviewRedirect(t, 3000)).toEqual({
			kind: 'redirect',
			location: 'http://localhost:3000',
		})
		// No port → primary (first).
		expect(resolvePreviewRedirect(t, null)).toEqual({
			kind: 'redirect',
			location: 'http://localhost:5173',
		})
	})

	it('reports not_found for an unknown port', () => {
		const t = task({
			metadata: { preview_ports: [port(5173, 'web', 'http://localhost:5173')] },
		})
		expect(resolvePreviewRedirect(t, 9999)).toEqual({ kind: 'not_found' })
	})

	it('reports not_found for a missing task', () => {
		expect(resolvePreviewRedirect(null)).toEqual({ kind: 'not_found' })
	})

	it('reports gone once the task is no longer active', () => {
		expect(
			resolvePreviewRedirect(
				task({
					status: 'done',
					metadata: { preview_ports: [port(4321, 'app', 'http://x')] },
				}),
			),
		).toEqual({ kind: 'gone' })
	})

	it('reports not_ready for an active task that has not reported ports yet', () => {
		expect(
			resolvePreviewRedirect(task({ status: 'assigned', metadata: { branch: 'x' } })),
		).toEqual({ kind: 'not_ready' })
	})
})
