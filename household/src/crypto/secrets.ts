/**
 * Authenticated encryption for secrets at rest (PATs, webhook secrets).
 *
 * Format on disk: `v1:<iv-base64>:<tag-base64>:<ciphertext-base64>`
 *   - AES-256-GCM (12-byte IV, 16-byte tag).
 *   - Master key from env `SECRETS_KEY` — base64 32 bytes (256 bits).
 *
 * This is libsodium-territory in spirit; we use Node's built-in crypto so
 * there's no native dep. Generate a key with `openssl rand -base64 32`.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

const VERSION = 'v1'
const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export class SecretCipher {
	private readonly key: Buffer

	constructor(masterKey: string | null) {
		this.key = deriveKey(masterKey)
	}

	encrypt(plaintext: string): string {
		const iv = randomBytes(IV_BYTES)
		const cipher = createCipheriv(ALGO, this.key, iv)
		const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
		const tag = cipher.getAuthTag()
		return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(
			':',
		)
	}

	decrypt(blob: string): string {
		const parts = blob.split(':')
		if (parts.length !== 4 || parts[0] !== VERSION) {
			throw new Error('invalid_secret_format')
		}
		const iv = Buffer.from(parts[1]!, 'base64')
		const tag = Buffer.from(parts[2]!, 'base64')
		const ct = Buffer.from(parts[3]!, 'base64')
		if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
			throw new Error('invalid_secret_iv_or_tag')
		}
		const decipher = createDecipheriv(ALGO, this.key, iv)
		decipher.setAuthTag(tag)
		const pt = Buffer.concat([decipher.update(ct), decipher.final()])
		return pt.toString('utf8')
	}
}

/**
 * Derive a 32-byte key from the user-provided master key. If env is missing
 * we use a deterministic dev key derived from a constant, **plus** a warning
 * — secrets are only as safe as the env. This keeps local dev unblocked
 * without crashing at startup; production must set SECRETS_KEY.
 */
function deriveKey(masterKey: string | null): Buffer {
	if (!masterKey) {
		// Stable dev fallback. Logged elsewhere as a warning.
		return createHash('sha256').update('night-agents:dev-only:do-not-use-in-prod').digest()
	}
	// Try base64 first (`openssl rand -base64 32` → ~44 chars).
	try {
		const buf = Buffer.from(masterKey, 'base64')
		if (buf.length === KEY_BYTES) return buf
	} catch {
		/* not base64 */
	}
	// Otherwise, hash the string to 32 bytes. Less cryptographically tidy
	// (entropy depends on input), but avoids surprising users who pasted a
	// passphrase.
	return createHash('sha256').update(masterKey).digest()
}
