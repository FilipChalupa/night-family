import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TokenStore } from './auth.ts'

interface Rig {
	store: TokenStore
	path: string
	cleanup: () => void
}

function createRig(): Rig {
	const dir = mkdtempSync(join(tmpdir(), 'night-tokens-test-'))
	const path = join(dir, 'tokens.yaml')
	return {
		store: new TokenStore(path),
		path,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	}
}

describe('TokenStore', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => rig.cleanup())

	it('returns empty list when file is missing', () => {
		expect(rig.store.list()).toEqual([])
	})

	it('round-trips create → validate → record usage', () => {
		const { raw, record } = rig.store.create('laptop', 'alice')
		expect(record.name).toBe('laptop')
		expect(record.created_by).toBe('alice')
		expect(record.revoked_at).toBeNull()
		expect(record.hash.startsWith('sha256:')).toBe(true)
		expect(raw).not.toContain(record.hash) // raw is the plain token, not the hash

		const validated = rig.store.validate(raw)
		expect(validated?.id).toBe(record.id)

		rig.store.recordUsage(record.id, {
			member_id: 'm-1',
			member_name: 'octo',
			connected_at: '2026-05-04T12:00:00Z',
		})
		const after = rig.store.list().find((t) => t.id === record.id)!
		expect(after.usage).toHaveLength(1)
		expect(after.usage?.[0]?.member_name).toBe('octo')
	})

	it('rejects an unknown raw token', () => {
		rig.store.create('laptop', 'alice')
		expect(rig.store.validate('not-a-real-token')).toBeNull()
	})

	it('rejects a revoked token even if the raw value matches', () => {
		const { raw, record } = rig.store.create('laptop', 'alice')
		expect(rig.store.revoke(record.id, 'alice')).toBe(true)
		expect(rig.store.validate(raw)).toBeNull()
		const stored = rig.store.list()[0]!
		expect(stored.revoked_at).not.toBeNull()
		expect(stored.revoked_by).toBe('alice')
	})

	it('refuses to double-revoke', () => {
		const { record } = rig.store.create('laptop', 'alice')
		expect(rig.store.revoke(record.id, 'alice')).toBe(true)
		expect(rig.store.revoke(record.id, 'bob')).toBe(false)
	})

	it('issues distinct raw tokens and ids on each create', () => {
		const a = rig.store.create('one', 'alice')
		const b = rig.store.create('two', 'alice')
		expect(a.raw).not.toBe(b.raw)
		expect(a.record.id).not.toBe(b.record.id)
		expect(a.record.hash).not.toBe(b.record.hash)
	})

	it('finds the earliest connection timestamp across all token usage', () => {
		const a = rig.store.create('one', 'alice')
		const b = rig.store.create('two', 'alice')
		rig.store.recordUsage(a.record.id, {
			member_id: 'm-1',
			member_name: 'octo',
			connected_at: '2026-05-04T12:00:00Z',
		})
		rig.store.recordUsage(b.record.id, {
			member_id: 'm-1',
			member_name: 'octo',
			connected_at: '2026-04-01T08:00:00Z', // earlier
		})
		rig.store.recordUsage(b.record.id, {
			member_id: 'm-2', // different member, ignored
			member_name: 'other',
			connected_at: '2025-01-01T00:00:00Z',
		})
		const earliest = rig.store.findFirstConnectionForMember('m-1')
		expect(earliest?.toISOString()).toBe('2026-04-01T08:00:00.000Z')
	})

	it('returns null first-connection lookup for unknown member', () => {
		expect(rig.store.findFirstConnectionForMember('m-unknown')).toBeNull()
	})

	it('persists across TokenStore instances pointing at the same file', () => {
		const { raw, record } = rig.store.create('laptop', 'alice')
		const fresh = new TokenStore(rig.path)
		expect(fresh.list().map((t) => t.id)).toEqual([record.id])
		expect(fresh.validate(raw)?.id).toBe(record.id)
	})
})
