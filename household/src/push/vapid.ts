/**
 * VAPID keypair management. We generate the pair on first start and persist
 * to `<config_dir>/.vapid-keys.json`; subsequent starts reuse the same pair
 * (rotating would invalidate every existing browser subscription). The keys
 * are not secrets in the same sense as `SECRETS_KEY` — the public half is
 * literally served via HTTP — but the private key still wants `0600` perms.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from 'pino'
import webpush from 'web-push'

const FILENAME = '.vapid-keys.json'

export interface VapidKeys {
	publicKey: string
	privateKey: string
}

interface OnDisk {
	publicKey: string
	privateKey: string
	createdAt: string
}

export function loadOrGenerateVapidKeys(opts: { configDir: string; logger: Logger }): VapidKeys {
	const path = join(opts.configDir, FILENAME)
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as OnDisk
		if (!parsed.publicKey || !parsed.privateKey) {
			throw new Error(`malformed VAPID keys at ${path}`)
		}
		return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
	}

	const generated = webpush.generateVAPIDKeys()
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(
		path,
		JSON.stringify(
			{
				publicKey: generated.publicKey,
				privateKey: generated.privateKey,
				createdAt: new Date().toISOString(),
			} satisfies OnDisk,
			null,
			'\t',
		),
		'utf8',
	)
	try {
		chmodSync(path, 0o600)
	} catch {
		// Best-effort. On platforms where chmod is a no-op (Windows, some FS
		// mounts) the keys are still in a project-private dir.
	}
	opts.logger.info({ path }, 'generated new VAPID keypair (first run)')
	return generated
}
