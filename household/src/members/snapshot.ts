import type { MemberRegistry, MemberSnapshot } from './registry.ts'
import type { MemberStateStore } from './store.ts'

export const OFFLINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Live members from the registry plus persisted members that disconnected
 * within the last OFFLINE_WINDOW_MS — so the dashboard surfaces recently
 * active members across reloads, not just the currently connected ones.
 */
export function buildMembersSnapshot(
	registry: MemberRegistry,
	store: MemberStateStore,
): MemberSnapshot[] {
	const live = registry.list()
	const liveIds = new Set(live.map((m) => m.memberId))
	const cutoff = new Date(Date.now() - OFFLINE_WINDOW_MS)
	const offline = store.listOfflineSince(cutoff).filter((m) => !liveIds.has(m.memberId))
	return [...live, ...offline]
}

/**
 * Look up one member by id. Returns the live registry entry if connected,
 * else the persisted snapshot regardless of how long ago it disconnected
 * (so deep links from old PR descriptions still resolve).
 */
export function getMemberSnapshotById(
	memberId: string,
	registry: MemberRegistry,
	store: MemberStateStore,
): MemberSnapshot | null {
	const live = registry.list().find((m) => m.memberId === memberId)
	if (live) return live
	return store.getById(memberId)
}
