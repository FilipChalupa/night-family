import { describe, expect, it } from 'vitest'
import type { TaskStatus } from '@night/shared'
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
		previousMemberId: overrides.previousMemberId ?? null,
		prAuthorLogin: overrides.prAuthorLogin ?? null,
		githubIssueNumber: overrides.githubIssueNumber ?? null,
		githubIssueUrl: overrides.githubIssueUrl ?? null,
		lastNotifiedStatus: overrides.lastNotifiedStatus ?? null,
		failureReason: overrides.failureReason ?? null,
		retryCount: overrides.retryCount ?? 0,
		createdAt: overrides.createdAt ?? '2026-05-04T12:00:00.000Z',
		updatedAt: overrides.updatedAt ?? '2026-05-04T12:00:00.000Z',
		metadata: overrides.metadata ?? null,
		reviewJobs: overrides.reviewJobs ?? null,
	}
}

/**
 * Build a tracker plus a step() helper that simulates the
 * read-from-row-then-write-back round-trip the real store does. Each step
 * call hands the tracker a task whose `lastNotifiedStatus` reflects the most
 * recent persisted value from prior steps.
 */
function rig() {
	const last = new Map<string, TaskStatus>()
	const tracker = new TaskPushTransitionTracker({
		setLastNotifiedStatus: (id, status) => last.set(id, status),
	})
	return {
		step(overrides: Partial<TaskRecord> & { id: string; status: TaskRecord['status'] }) {
			const t = task({ ...overrides, lastNotifiedStatus: last.get(overrides.id) ?? null })
			return tracker.observe(t)
		},
	}
}

describe('TaskPushTransitionTracker', () => {
	it('treats the first observation as a baseline (no notification)', () => {
		const r = rig()
		expect(r.step({ id: 't1', status: 'failed' })).toBeNull()
	})

	it('emits a payload on the first real status transition', () => {
		const r = rig()
		r.step({ id: 't1', status: 'in-progress' })
		const payload = r.step({ id: 't1', status: 'failed', failureReason: 'oops' })
		expect(payload?.title).toBe('Task failed')
		expect(payload?.body).toContain('oops')
		expect(payload?.taskId).toBe('t1')
	})

	it('does not duplicate when the same status arrives again (republish case)', () => {
		const r = rig()
		r.step({ id: 't1', status: 'in-progress' })
		expect(r.step({ id: 't1', status: 'failed', failureReason: 'first' })).not.toBeNull()
		// Subsequent task.updated emissions for the same task with the same
		// status (e.g. republish on a review job state change) must be silent.
		expect(r.step({ id: 't1', status: 'failed', failureReason: 'first' })).toBeNull()
	})

	it('detects in-review → queued as "review requested changes"', () => {
		const r = rig()
		r.step({ id: 't1', status: 'in-review' })
		const payload = r.step({ id: 't1', status: 'queued' })
		expect(payload?.title).toBe('Review requested changes')
	})

	it('emits awaiting-merge as "Ready for merge"', () => {
		const r = rig()
		r.step({ id: 't1', status: 'in-review' })
		const payload = r.step({ id: 't1', status: 'awaiting-merge' })
		expect(payload?.title).toBe('Ready for merge')
	})

	it('emits done when a task completes', () => {
		const r = rig()
		r.step({ id: 't1', status: 'awaiting-merge' })
		const payload = r.step({ id: 't1', status: 'done' })
		expect(payload?.title).toBe('Task done')
	})

	it('returns null for transitions we deliberately ignore', () => {
		const r = rig()
		r.step({ id: 't1', status: 'new' })
		expect(r.step({ id: 't1', status: 'queued' })).toBeNull()
		expect(r.step({ id: 't1', status: 'assigned' })).toBeNull()
		expect(r.step({ id: 't1', status: 'in-progress' })).toBeNull()
		expect(r.step({ id: 't1', status: 'in-review' })).toBeNull()
	})

	it('a row that comes in with lastNotifiedStatus already set (post-restart) does not double-fire', () => {
		const r = rig()
		// Simulate a Household restart: the task already has lastNotifiedStatus=
		// 'failed' from before the restart. Receiving another `task.updated` with
		// the same status (e.g. on a republish) must stay silent.
		expect(r.step({ id: 't1', status: 'failed', lastNotifiedStatus: 'failed' })).toBeNull()
	})
})
