import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSecretsKey, SecretCipher } from './secrets.ts'

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	trace: () => {},
	fatal: () => {},
	level: 'silent',
	child: () => silentLogger,
} as unknown as Parameters<typeof resolveSecretsKey>[0]['logger']

describe('SecretCipher', () => {
	it('round-trips plaintext', () => {
		const c = new SecretCipher('dGhpc2lzYXRlc3RrZXl0aGlzaXNhdGVzdGtleTEyMw==')
		const blob = c.encrypt('ghp_supersecret_token_value_123')
		expect(blob).toMatch(/^v1:/)
		expect(c.decrypt(blob)).toBe('ghp_supersecret_token_value_123')
	})

	it('produces different ciphertext per call (non-deterministic IV)', () => {
		const c = new SecretCipher('dGhpc2lzYXRlc3RrZXl0aGlzaXNhdGVzdGtleTEyMw==')
		const a = c.encrypt('x')
		const b = c.encrypt('x')
		expect(a).not.toBe(b)
		expect(c.decrypt(a)).toBe('x')
		expect(c.decrypt(b)).toBe('x')
	})

	it('rejects tampered ciphertext (auth tag mismatch)', () => {
		const c = new SecretCipher('dGhpc2lzYXRlc3RrZXl0aGlzaXNhdGVzdGtleTEyMw==')
		const blob = c.encrypt('hello')
		const parts = blob.split(':')
		// Flip a byte in the ciphertext
		const tampered = Buffer.from(parts[3]!, 'base64')
		tampered[0] = tampered[0]! ^ 1
		parts[3] = tampered.toString('base64')
		expect(() => c.decrypt(parts.join(':'))).toThrow()
	})

	it('rejects wrong key', () => {
		const a = new SecretCipher('a'.repeat(44))
		const b = new SecretCipher('b'.repeat(44))
		const blob = a.encrypt('hello')
		expect(() => b.decrypt(blob)).toThrow()
	})

	it('falls back to dev key when env is missing (round-trips within process)', () => {
		const c = new SecretCipher(null)
		const blob = c.encrypt('hi')
		expect(c.decrypt(blob)).toBe('hi')
	})
})

describe('resolveSecretsKey', () => {
	const mkConfigDir = () => mkdtempSync(join(tmpdir(), 'night-secrets-'))

	it('prefers env value when present', () => {
		const dir = mkConfigDir()
		try {
			const { value, source } = resolveSecretsKey({
				envValue: 'env-supplied-key',
				configDir: dir,
				logger: silentLogger,
			})
			expect(value).toBe('env-supplied-key')
			expect(source.kind).toBe('env')
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('generates and persists a key on first call', () => {
		const dir = mkConfigDir()
		try {
			const r = resolveSecretsKey({ envValue: null, configDir: dir, logger: silentLogger })
			expect(r.source.kind).toBe('file')
			if (r.source.kind === 'file') expect(r.source.generated).toBe(true)
			expect(r.value.length).toBeGreaterThan(40)

			const path = join(dir, '.secrets-key')
			expect(readFileSync(path, 'utf8').trim()).toBe(r.value)
			// On POSIX, mode should be 0600. The low 9 bits encode rwxrwxrwx.
			if (process.platform !== 'win32') {
				const mode = statSync(path).mode & 0o777
				expect(mode).toBe(0o600)
			}
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('reuses an existing key file across calls', () => {
		const dir = mkConfigDir()
		try {
			const a = resolveSecretsKey({ envValue: null, configDir: dir, logger: silentLogger })
			const b = resolveSecretsKey({ envValue: null, configDir: dir, logger: silentLogger })
			expect(b.value).toBe(a.value)
			if (b.source.kind === 'file') expect(b.source.generated).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('rejects an empty key file rather than silently regenerating', () => {
		const dir = mkConfigDir()
		try {
			writeFileSync(join(dir, '.secrets-key'), '   \n', 'utf8')
			expect(() =>
				resolveSecretsKey({ envValue: null, configDir: dir, logger: silentLogger }),
			).toThrow(/empty/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
