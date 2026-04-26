import { randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { sessions } from '../db/schema.ts'
import type { Db } from '../db/index.ts'

export const SESSION_COOKIE = 'night_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const SESSION_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface SessionRecord {
	id: string
	githubUsername: string
	role: 'admin' | 'readonly'
	expiresAt: Date
	csrfToken: string
}

export class SessionStore {
	constructor(private readonly db: Db) {}

	create(githubUsername: string, role: 'admin' | 'readonly'): SessionRecord {
		const id = randomBytes(32).toString('base64url')
		const csrfToken = randomBytes(24).toString('base64url')
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
		this.db
			.insert(sessions)
			.values({
				id,
				githubUsername,
				role,
				expiresAt,
				csrfToken,
			})
			.run()
		return { id, githubUsername, role, expiresAt, csrfToken }
	}

	get(id: string): SessionRecord | null {
		const rows = this.db.select().from(sessions).where(eq(sessions.id, id)).all()
		const row = rows[0]
		if (!row) return null
		if (row.expiresAt.getTime() <= Date.now()) {
			this.delete(id)
			return null
		}
		return {
			id: row.id,
			githubUsername: row.githubUsername,
			role: row.role as 'admin' | 'readonly',
			expiresAt: row.expiresAt,
			csrfToken: row.csrfToken,
		}
	}

	delete(id: string): void {
		this.db.delete(sessions).where(eq(sessions.id, id)).run()
	}

	/**
	 * Rolling refresh: if the session is older than threshold, push expiry out.
	 * Returns the (possibly new) expiry.
	 */
	maybeRefresh(id: string): Date | null {
		const row = this.db.select().from(sessions).where(eq(sessions.id, id)).all()[0]
		if (!row) return null
		const remaining = row.expiresAt.getTime() - Date.now()
		if (remaining <= 0) return null
		if (remaining < SESSION_TTL_MS - SESSION_REFRESH_THRESHOLD_MS) {
			const newExpiry = new Date(Date.now() + SESSION_TTL_MS)
			this.db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, id)).run()
			return newExpiry
		}
		return row.expiresAt
	}

	purgeExpired(): void {
		this.db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run()
	}
}
