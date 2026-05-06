/**
 * Repo bindings — per-repo (`org/name`) configuration. Holds only the
 * webhook secret used to validate inbound HMAC. GitHub PATs are no longer
 * household-side; each member supplies its own via env (`GITHUB_PAT`).
 */

import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { repoBindings, webhookDeliveries } from '../db/schema.ts'
import type { SecretCipher } from '../crypto/secrets.ts'

export interface RepoBinding {
	repo: string
	createdAt: string
	updatedAt: string
	/** ISO of the most recent webhook delivery received for this repo, or null if none yet. */
	lastEventAt: string | null
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
		const rows = this.db.select().from(repoBindings).all()
		const lastEventByRepo = this.lastEventByRepo()
		return rows.map((r) => ({
			repo: r.repo,
			createdAt: r.createdAt.toISOString(),
			updatedAt: r.updatedAt.toISOString(),
			lastEventAt: lastEventByRepo.get(r.repo) ?? null,
		}))
	}

	publicView(repo: string): RepoBinding | null {
		const r = this.db.select().from(repoBindings).where(eq(repoBindings.repo, repo)).all()[0]
		if (!r) return null
		return {
			repo: r.repo,
			createdAt: r.createdAt.toISOString(),
			updatedAt: r.updatedAt.toISOString(),
			lastEventAt: this.lastEventByRepo().get(r.repo) ?? null,
		}
	}

	/**
	 * MAX(received_at) per repo across `webhook_deliveries`. Bounded by
	 * webhook delivery retention, so older repos may show a stale-or-null
	 * value once their last delivery ages out.
	 */
	private lastEventByRepo(): Map<string, string> {
		const rows = this.db
			.select({
				repo: webhookDeliveries.repo,
				lastMs: sql<number>`MAX(${webhookDeliveries.receivedAt})`,
			})
			.from(webhookDeliveries)
			.groupBy(webhookDeliveries.repo)
			.all()
		const out = new Map<string, string>()
		for (const r of rows) {
			if (r.lastMs == null) continue
			out.set(r.repo, new Date(Number(r.lastMs)).toISOString())
		}
		return out
	}

	getWebhookSecret(repo: string): string | null {
		const r = this.db.select().from(repoBindings).where(eq(repoBindings.repo, repo)).all()[0]
		if (!r) return null
		return this.cipher.decrypt(r.webhookSecretEnc)
	}
}
