import { and, eq, gte, sql } from 'drizzle-orm'
import type { Provider, Skill, WorkerProfile } from '@night/shared'
import type { Db } from '../db/index.ts'
import { members } from '../db/schema.ts'
import type { MemberSnapshot } from './registry.ts'

/**
 * Snapshot of an offline member reconstructed from the persisted `members`
 * table — used by the UI to surface members that were active recently but
 * are not currently connected.
 *
 * Shape mirrors `MemberSnapshot` so the UI doesn't need a second type. The
 * `sessionId` is synthesized (`offline:<member_id>`) since there's no live
 * session to attach to; React just uses it as a row key.
 */
export interface OfflineMemberSnapshot extends MemberSnapshot {
	status: 'offline'
}

export interface UpsertConnectInput {
	memberId: string
	memberName: string
	displayName: string
	skills: Skill[]
	repos: string[] | null
	provider: Provider
	model: string
	workerProfile: WorkerProfile
	protocolVersion: string
	tokenId: string
	connectedAt: Date
}

export class MemberStateStore {
	constructor(private readonly db: Db) {}

	/**
	 * Insert or refresh a member's persisted snapshot on (re)connect. Sets
	 * `last_connected_at` and `last_seen_at` to now and clears
	 * `last_disconnected_at` so the row reads as currently online from the
	 * persistence layer's POV.
	 *
	 * `first_connected_at` is preserved across upserts — only set on first
	 * insert.
	 */
	upsertOnConnect(input: UpsertConnectInput): void {
		const ts = input.connectedAt
		this.db
			.insert(members)
			.values({
				memberId: input.memberId,
				memberName: input.memberName,
				displayName: input.displayName,
				skills: JSON.stringify(input.skills),
				repos: input.repos ? JSON.stringify(input.repos) : null,
				provider: input.provider,
				model: input.model,
				workerProfile: input.workerProfile,
				protocolVersion: input.protocolVersion,
				tokenId: input.tokenId,
				firstConnectedAt: ts,
				lastConnectedAt: ts,
				lastSeenAt: ts,
				lastDisconnectedAt: null,
			})
			.onConflictDoUpdate({
				target: members.memberId,
				set: {
					memberName: input.memberName,
					displayName: input.displayName,
					skills: JSON.stringify(input.skills),
					repos: input.repos ? JSON.stringify(input.repos) : null,
					provider: input.provider,
					model: input.model,
					workerProfile: input.workerProfile,
					protocolVersion: input.protocolVersion,
					tokenId: input.tokenId,
					lastConnectedAt: ts,
					lastSeenAt: ts,
					lastDisconnectedAt: null,
				},
			})
			.run()
	}

	touch(memberId: string, at: Date = new Date()): void {
		this.db.update(members).set({ lastSeenAt: at }).where(eq(members.memberId, memberId)).run()
	}

	markDisconnected(memberId: string, at: Date = new Date()): void {
		this.db
			.update(members)
			.set({ lastSeenAt: at, lastDisconnectedAt: at })
			.where(eq(members.memberId, memberId))
			.run()
	}

	getName(memberId: string): string | null {
		const row = this.db
			.select({ memberName: members.memberName })
			.from(members)
			.where(eq(members.memberId, memberId))
			.get()
		return row?.memberName ?? null
	}

	/**
	 * Return persisted offline members whose `last_seen_at` is at or after
	 * the given cutoff. Caller is responsible for filtering out members
	 * currently in the live registry.
	 */
	listOfflineSince(cutoff: Date): OfflineMemberSnapshot[] {
		const rows = this.db
			.select()
			.from(members)
			.where(
				and(
					gte(members.lastSeenAt, cutoff),
					sql`${members.lastDisconnectedAt} IS NOT NULL`,
				),
			)
			.all()
		return rows.map(rowToOfflineSnapshot)
	}

	/**
	 * Idempotent backfill of members from `tokens.yaml` usage entries — fills
	 * in older `first_connected_at` and newer `last_connected_at`/`last_seen_at`
	 * for stub rows created by the migration. Doesn't touch identity or
	 * profile fields, which the migration can only stub from `tasks` data.
	 */
	bootstrapFromTokenUsage(
		entries: Array<{ memberId: string; memberName: string; connectedAt: Date }>,
	): void {
		if (entries.length === 0) return
		// Group by memberId to find the min/max per member.
		const byMember = new Map<string, { name: string; min: Date; max: Date }>()
		for (const e of entries) {
			const existing = byMember.get(e.memberId)
			if (!existing) {
				byMember.set(e.memberId, {
					name: e.memberName,
					min: e.connectedAt,
					max: e.connectedAt,
				})
			} else {
				if (e.connectedAt < existing.min) existing.min = e.connectedAt
				if (e.connectedAt > existing.max) existing.max = e.connectedAt
			}
		}
		for (const [memberId, agg] of byMember) {
			const existing = this.db
				.select()
				.from(members)
				.where(eq(members.memberId, memberId))
				.get()
			if (!existing) {
				this.db
					.insert(members)
					.values({
						memberId,
						memberName: agg.name,
						displayName: agg.name,
						firstConnectedAt: agg.min,
						lastConnectedAt: agg.max,
						lastSeenAt: agg.max,
						lastDisconnectedAt: agg.max,
					})
					.run()
			} else {
				const next: Partial<typeof members.$inferInsert> = {}
				if (agg.min < existing.firstConnectedAt) next.firstConnectedAt = agg.min
				if (agg.max > existing.lastConnectedAt) next.lastConnectedAt = agg.max
				if (agg.max > existing.lastSeenAt) next.lastSeenAt = agg.max
				// Only touch member_name / display_name when the existing row was
				// stubbed by the migration ('unknown'); never overwrite fresher
				// runtime data from a real connect.
				if (existing.memberName === 'unknown') next.memberName = agg.name
				if (existing.displayName === 'unknown') next.displayName = agg.name
				if (Object.keys(next).length > 0) {
					this.db.update(members).set(next).where(eq(members.memberId, memberId)).run()
				}
			}
		}
	}
}

function rowToOfflineSnapshot(row: typeof members.$inferSelect): OfflineMemberSnapshot {
	return {
		sessionId: `offline:${row.memberId}`,
		memberId: row.memberId,
		memberName: row.memberName,
		displayName: row.displayName,
		skills: parseJsonArray(row.skills) as Skill[],
		repos: row.repos ? (parseJsonArray(row.repos) as string[]) : null,
		provider: (row.provider || 'unknown') as Provider,
		model: row.model,
		workerProfile: (row.workerProfile || 'unknown') as WorkerProfile,
		protocolVersion: row.protocolVersion,
		tokenId: row.tokenId ?? '',
		connectedAt: row.lastConnectedAt.toISOString(),
		firstConnectedAt: row.firstConnectedAt.toISOString(),
		status: 'offline',
		currentTask: null,
		lastHeartbeat: row.lastSeenAt.toISOString(),
	}
}

function parseJsonArray(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
	} catch {
		return []
	}
}
