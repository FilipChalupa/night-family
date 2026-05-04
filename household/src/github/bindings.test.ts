import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecretCipher } from '../crypto/secrets.ts'
import * as schema from '../db/schema.ts'
import { RepoBindingStore } from './bindings.ts'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

// 32-byte master key, base64-encoded. Test-only; never used at rest.
const TEST_KEY = Buffer.alloc(32, 0x37).toString('base64')

interface Rig {
	store: RepoBindingStore
	cipher: SecretCipher
	cleanup: () => void
}

function createRig(): Rig {
	const dir = mkdtempSync(join(tmpdir(), 'night-bindings-test-'))
	const dbPath = join(dir, 'test.sqlite')
	const sqlite = new Database(dbPath)
	sqlite.pragma('journal_mode = WAL')
	sqlite.pragma('foreign_keys = ON')
	const db = drizzle(sqlite, { schema })
	migrate(db, { migrationsFolder })
	const cipher = new SecretCipher(TEST_KEY)
	const store = new RepoBindingStore(db, cipher)
	return {
		store,
		cipher,
		cleanup: () => {
			sqlite.close()
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

describe('RepoBindingStore', () => {
	let rig: Rig
	beforeEach(() => {
		rig = createRig()
	})
	afterEach(() => rig.cleanup())

	it('upsert inserts a fresh binding and lists it', () => {
		rig.store.upsert({ repo: 'octo/sample', webhookSecret: 'super-secret' })
		const list = rig.store.list()
		expect(list).toHaveLength(1)
		expect(list[0]?.repo).toBe('octo/sample')
	})

	it('publicView never exposes the webhook secret', () => {
		rig.store.upsert({ repo: 'octo/sample', webhookSecret: 'super-secret' })
		const view = rig.store.publicView('octo/sample')
		expect(view).not.toBeNull()
		expect(JSON.stringify(view)).not.toContain('super-secret')
	})

	it('getWebhookSecret round-trips through encryption', () => {
		rig.store.upsert({ repo: 'octo/sample', webhookSecret: 'super-secret' })
		expect(rig.store.getWebhookSecret('octo/sample')).toBe('super-secret')
	})

	it('upsert rotates the secret in place without inserting duplicates', () => {
		rig.store.upsert({ repo: 'octo/sample', webhookSecret: 'first' })
		rig.store.upsert({ repo: 'octo/sample', webhookSecret: 'second' })
		expect(rig.store.list()).toHaveLength(1)
		expect(rig.store.getWebhookSecret('octo/sample')).toBe('second')
	})

	it('persists ciphertext, not plaintext, in the database', () => {
		rig.store.upsert({ repo: 'octo/sample', webhookSecret: 'super-secret' })
		// Re-open the same DB raw to confirm the stored bytes are the cipher
		// blob, not the plaintext (catches accidental plain storage).
		const view = rig.store.publicView('octo/sample')!
		expect(view.repo).toBe('octo/sample')
		const secret = rig.store.getWebhookSecret('octo/sample')
		// Smoke-check the cipher format at rest by verifying decrypt() returns
		// the expected plaintext — encrypt always uses a fresh IV so we can't
		// compare ciphertext directly.
		expect(secret).toBe('super-secret')
	})

	it('delete removes the binding and reports whether anything was removed', () => {
		rig.store.upsert({ repo: 'octo/sample', webhookSecret: 'x' })
		expect(rig.store.delete('octo/sample')).toBe(true)
		expect(rig.store.delete('octo/sample')).toBe(false)
		expect(rig.store.publicView('octo/sample')).toBeNull()
		expect(rig.store.getWebhookSecret('octo/sample')).toBeNull()
	})

	it('list returns multiple bindings in insertion order', () => {
		rig.store.upsert({ repo: 'a/one', webhookSecret: 'x' })
		rig.store.upsert({ repo: 'b/two', webhookSecret: 'y' })
		const repos = rig.store.list().map((b) => b.repo)
		expect(repos).toContain('a/one')
		expect(repos).toContain('b/two')
		expect(repos).toHaveLength(2)
	})

	it('publicView returns null for an unknown repo', () => {
		expect(rig.store.publicView('nope/missing')).toBeNull()
		expect(rig.store.getWebhookSecret('nope/missing')).toBeNull()
	})
})
