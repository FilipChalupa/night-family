import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../tasks/store.ts'
import { TaskPushTransitionTracker } from './taskTransitions.ts'

function task(
	overrides: Partial<TaskRecord> & { id: string; status: TaskRecord['status'] },
): TaskRecord {
	return {
		id: overrides.id,
		repo: overrides.repo ?? null,
		kind: overrides.kind ?? 'implement',
		title: overrides.title ?? 'Test task',
		description: overrides.description ?? '',
		status: overrides.status,
		estimateSize: overrides.estimateSize ?? null,
		estimateBlockers: overrides.estimateBlockers ?? null,
		prUrl: overrides.prUrl ?? null,
		assignedSessionId: overrides.assignedSessionId ?? null,
		assignedMemberId: overrides.assignedMemberId ?? null,
		assignedMemberName: overrides.assignedMemberName ?? null,
		failureReason: overrides.failureReason ?? null,
		retryCount: overrides.retryCount ?? 0,
		createdAt: overrides.createdAt ?? '2026-05-04T12:00:00.000Z',
		updatedAt: overrides.updatedAt ?? '2026-05-04T12:00:00.000Z',
		metadata: overrides.metadata ?? null,
		reviewJobs: overrides.reviewJobs ?? null,
	}
}

describe('TaskPushTransitionTracker', () => {
	it('treats the first observation as a baseline (no notification)', () => {
		const tracker = new TaskPushTransitionTracker()
		expect(tracker.observe(task({ id: 't1', status: 'failed' }))).toBeNull()
	})

	it('emits a payload on the first real status transition', () => {
		const tracker = new TaskPushTransitionTracker()
		tracker.observe(task({ id: 't1', status: 'in-progress' }))
		const payload = tracker.observe(task({ id: 't1', status: 'failed', failureReason: 'oops' }))
		expect(payload?.title).toBe('Task failed')
		expect(payload?.body).toContain('oops')
		expect(payload?.taskId).toBe('t1')
	})

	it('does not duplicate when the same status arrives again (republish case)', () => {
		const tracker = new TaskPushTransitionTracker()
		tracker.observe(task({ id: 't1', status: 'in-progress' }))
		expect(
			tracker.observe(task({ id: 't1', status: 'failed', failureReason: 'first' })),
		).not.toBeNull()
		// Subsequent task.updated emissions for the same task with the same
		// status (e.g. republish on a review job state change) must be silent.
		expect(
			tracker.observe(task({ id: 't1', status: 'failed', failureReason: 'first' })),
		).toBeNull()
	})

	it('detects in-review → queued as "review requested changes"', () => {
		const tracker = new TaskPushTransitionTracker()
		tracker.observe(task({ id: 't1', status: 'in-review' }))
		const payload = tracker.observe(task({ id: 't1', status: 'queued' }))
		expect(payload?.title).toBe('Review requested changes')
	})

	it('emits awaiting-merge as "Ready for merge"', () => {
		const tracker = new TaskPushTransitionTracker()
		tracker.observe(task({ id: 't1', status: 'in-review' }))
		const payload = tracker.observe(task({ id: 't1', status: 'awaiting-merge' }))
		expect(payload?.title).toBe('Ready for merge')
	})

	it('emits done when a task completes', () => {
		const tracker = new TaskPushTransitionTracker()
		tracker.observe(task({ id: 't1', status: 'awaiting-merge' }))
		const payload = tracker.observe(task({ id: 't1', status: 'done' }))
		expect(payload?.title).toBe('Task done')
	})

	it('returns null for transitions we deliberately ignore', () => {
		const tracker = new TaskPushTransitionTracker()
		tracker.observe(task({ id: 't1', status: 'new' }))
		expect(tracker.observe(task({ id: 't1', status: 'queued' }))).toBeNull()
		expect(tracker.observe(task({ id: 't1', status: 'assigned' }))).toBeNull()
		expect(tracker.observe(task({ id: 't1', status: 'in-progress' }))).toBeNull()
		expect(tracker.observe(task({ id: 't1', status: 'in-review' }))).toBeNull()
	})

	it('forget() drops the cached prior status so the next observation is a baseline again', () => {
		const tracker = new TaskPushTransitionTracker()
		tracker.observe(task({ id: 't1', status: 'in-progress' }))
		tracker.forget('t1')
		// Next observe is treated as first-seen, so even a `failed` status is silent.
		expect(tracker.observe(task({ id: 't1', status: 'failed' }))).toBeNull()
	})
})
