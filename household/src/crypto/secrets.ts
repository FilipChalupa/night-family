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
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from 'pino'

const VERSION = 'v1'
const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const KEY_FILENAME = '.secrets-key'

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

export type SecretsKeySource = { kind: 'env' } | { kind: 'file'; path: string; generated: boolean }

/**
 * Resolve the master key in priority order:
 *   1. `envValue` (e.g. process.env.SECRETS_KEY) — for deploys with a real
 *      secrets manager (k8s, 1Password, …).
 *   2. `<configDir>/.secrets-key` if it exists — auto-generated on previous
 *      run, kept across restarts.
 *   3. Generate 32 random bytes (base64), write to `<configDir>/.secrets-key`
 *      with 0600 perms, return.
 *
 * The file lives in `/config` (not `/data`) so the encryption key is on a
 * different volume than the ciphertext it protects, and so it rides along
 * with the regularly-backed-up config volume.
 */
export function resolveSecretsKey(opts: {
	envValue: string | null
	configDir: string
	logger: Logger
}): { value: string; source: SecretsKeySource } {
	if (opts.envValue && opts.envValue.length > 0) {
		opts.logger.info('using SECRETS_KEY from env')
		return { value: opts.envValue, source: { kind: 'env' } }
	}

	const path = join(opts.configDir, KEY_FILENAME)

	if (existsSync(path)) {
		const value = readFileSync(path, 'utf8').trim()
		if (value.length === 0) {
			throw new Error(`secrets key file is empty: ${path}`)
		}
		opts.logger.info({ path }, 'loaded secrets key from disk')
		return { value, source: { kind: 'file', path, generated: false } }
	}

	mkdirSync(opts.configDir, { recursive: true })
	const value = randomBytes(KEY_BYTES).toString('base64')
	writeFileSync(path, value + '\n', { encoding: 'utf8', mode: 0o600 })
	try {
		chmodSync(path, 0o600)
	} catch {
		/* best-effort; some filesystems (e.g. Windows mounts) ignore mode */
	}
	opts.logger.warn(
		{ path },
		'generated new secrets key — back up this file alongside /config to avoid losing encrypted PATs',
	)
	return { value, source: { kind: 'file', path, generated: true } }
}
