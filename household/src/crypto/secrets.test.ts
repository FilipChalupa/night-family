import { describe, expect, it } from 'vitest'
import { SecretCipher } from './secrets.ts'

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
