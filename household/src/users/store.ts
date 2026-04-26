/**
 * Users — admin & readonly accounts allowed into the web UI. Identity is the
 * GitHub username (no validation against GitHub; admin types it correctly).
 *
 * /config/users.yaml format:
 *   primary_admin: filiph
 *   users:
 *     - username: filiph
 *       role: admin
 *       added_at: 2026-04-26T10:00:00Z
 *       added_by: filiph
 *     - username: alice
 *       role: readonly
 *       added_at: 2026-04-26T11:00:00Z
 *       added_by: filiph
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, stringify } from 'yaml'

export type UserRole = 'admin' | 'readonly'

export interface UserRecord {
	username: string
	role: UserRole
	added_at: string
	added_by: string
}

interface UsersFile {
	primary_admin: string
	users: UserRecord[]
}

export class UserStore {
	constructor(
		private readonly path: string,
		private readonly primaryAdminUsername: string,
	) {}

	private load(): UsersFile {
		if (!existsSync(this.path)) {
			return { primary_admin: this.primaryAdminUsername, users: [] }
		}
		const raw = readFileSync(this.path, 'utf8')
		const parsed = parse(raw) as UsersFile | null
		return parsed ?? { primary_admin: this.primaryAdminUsername, users: [] }
	}

	private save(data: UsersFile): void {
		mkdirSync(dirname(this.path), { recursive: true })
		writeFileSync(this.path, stringify(data), 'utf8')
	}

	/**
	 * Ensure the primary admin from env is present in the users list. Run
	 * once at startup. Idempotent.
	 */
	bootstrapPrimaryAdmin(): void {
		const data = this.load()
		data.primary_admin = this.primaryAdminUsername
		const exists = data.users.some(
			(u) => u.username.toLowerCase() === this.primaryAdminUsername.toLowerCase(),
		)
		if (!exists) {
			data.users.push({
				username: this.primaryAdminUsername,
				role: 'admin',
				added_at: new Date().toISOString(),
				added_by: 'system',
			})
		} else {
			// Force role=admin for primary admin; admin can't demote themselves.
			for (const u of data.users) {
				if (u.username.toLowerCase() === this.primaryAdminUsername.toLowerCase()) {
					u.role = 'admin'
				}
			}
		}
		this.save(data)
	}

	list(): UserRecord[] {
		return this.load().users
	}

	primaryAdmin(): string {
		return this.load().primary_admin
	}

	get(username: string): UserRecord | null {
		const data = this.load()
		return data.users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null
	}

	add(username: string, role: UserRole, addedBy: string): UserRecord {
		const data = this.load()
		if (data.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
			throw new Error(`User already exists: ${username}`)
		}
		const record: UserRecord = {
			username,
			role,
			added_at: new Date().toISOString(),
			added_by: addedBy,
		}
		data.users.push(record)
		this.save(data)
		return record
	}

	remove(username: string): boolean {
		const data = this.load()
		if (username.toLowerCase() === data.primary_admin.toLowerCase()) {
			throw new Error('Cannot remove primary admin')
		}
		const before = data.users.length
		data.users = data.users.filter((u) => u.username.toLowerCase() !== username.toLowerCase())
		if (data.users.length === before) return false
		this.save(data)
		return true
	}

	setRole(username: string, role: UserRole): boolean {
		const data = this.load()
		if (username.toLowerCase() === data.primary_admin.toLowerCase() && role !== 'admin') {
			throw new Error('Cannot demote primary admin')
		}
		const u = data.users.find((x) => x.username.toLowerCase() === username.toLowerCase())
		if (!u) return false
		u.role = role
		this.save(data)
		return true
	}
}
