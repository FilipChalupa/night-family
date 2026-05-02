/**
 * Repo bindings — per-repo (`org/name`) configuration. Holds only the
 * webhook secret used to validate inbound HMAC. GitHub PATs are no longer
 * household-side; each member supplies its own via env (`GITHUB_PAT`).
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { repoBindings } from '../db/schema.ts'
import type { SecretCipher } from '../crypto/secrets.ts'

export interface RepoBinding {
	repo: string
	createdAt: string
	updatedAt: string
}

export class RepoBindingStore {
	constructor(
		private readonly db: Db,
		private readonly cipher: SecretCipher,
	) {}

	upsert(input: { repo: string; webhookSecret: string }): RepoBinding {
		const existing = this.db
			.select()
			.from(repoBindings)
			.where(eq(repoBindings.repo, input.repo))
			.all()[0]

		const webhookSecretEnc = this.cipher.encrypt(input.webhookSecret)

		const now = new Date()
		if (existing) {
			this.db
				.update(repoBindings)
				.set({ webhookSecretEnc, updatedAt: now })
				.where(eq(repoBindings.repo, input.repo))
				.run()
		} else {
			this.db
				.insert(repoBindings)
				.values({
					repo: input.repo,
					webhookSecretEnc,
					createdAt: now,
					updatedAt: now,
				})
				.run()
		}
		return this.publicView(input.repo)!
	}

	delete(repo: string): boolean {
		const result = this.db.delete(repoBindings).where(eq(repoBindings.repo, repo)).run()
		return result.changes > 0
	}

	list(): RepoBinding[] {
		return this.db
			.select()
			.from(repoBindings)
			.all()
			.map((r) => ({
				repo: r.repo,
				createdAt: r.createdAt.toISOString(),
				updatedAt: r.updatedAt.toISOString(),
			}))
	}

	publicView(repo: string): RepoBinding | null {
		const r = this.db.select().from(repoBindings).where(eq(repoBindings.repo, repo)).all()[0]
		if (!r) return null
		return {
			repo: r.repo,
			createdAt: r.createdAt.toISOString(),
			updatedAt: r.updatedAt.toISOString(),
		}
	}

	getWebhookSecret(repo: string): string | null {
		const r = this.db.select().from(repoBindings).where(eq(repoBindings.repo, repo)).all()[0]
		if (!r) return null
		return this.cipher.decrypt(r.webhookSecretEnc)
	}
}
