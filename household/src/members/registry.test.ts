import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServerInfo } from '@night/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema.ts'
import { MemberRegistry, type ConnectedMember, type RegistryEvent } from './registry.ts'
import { MemberStateStore } from './store.ts'

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')

function connectedMember(overrides: Partial<ConnectedMember> = {}): ConnectedMember {
	const now = new Date()
	return {
		sessionId: 'sess-1',
		memberId: 'mid-1',
		memberName: 'octo',
		displayName: 'Octo',
		skills: ['implement'],
		schedule: {
			timezone: 'UTC',
			nightWindows: [
				{
					name: 'always',
					days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
					start: '00:00',
					end: '24:00',
				},
			],
		},
		override: null,
		repos: null,
		provider: 'anthropic',
		model: 'm',
		workerProfile: 'medium',
		mcpServers: [],
		protocolVersion: '3.4.0',
		tokenId: 'tok',
		maxTokensPerDay: null,
		connectedAt: now,
		firstConnectedAt: now,
		status: 'idle',
		currentTask: null,
		lastHeartbeat: now,
		lastReposError: null,
		send: () => {},
		close: () => {},
		...overrides,
	}
}

describe('MemberRegistry.updateMcpServers', () => {
	let dir: string
	let store: MemberStateStore
	let registry: MemberRegistry

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'night-reg-test-'))
		const sqlite = new Database(join(dir, 'test.sqlite'))
		sqlite.pragma('foreign_keys = ON')
		const db = drizzle(sqlite, { schema })
		migrate(db, { migrationsFolder })
		store = new MemberStateStore(db)
		registry = new MemberRegistry(store)
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	const servers: McpServerInfo[] = [
		{ name: 'linear', status: 'live', tool_count: 3 },
		{ name: 'slack', status: 'down', tool_count: 0 },
	]

	it('updates the live snapshot and emits member.updated', () => {
		registry.add(connectedMember())
		const events: RegistryEvent[] = []
		registry.on((e) => events.push(e))

		const changed = registry.updateMcpServers('sess-1', servers)
		expect(changed).toBe(true)

		const updated = events.find((e) => e.type === 'member.updated')
		expect(updated).toBeDefined()
		if (updated?.type === 'member.updated') {
			expect(updated.member.mcpServers).toEqual(servers)
		}
		expect(registry.list().find((m) => m.sessionId === 'sess-1')?.mcpServers).toEqual(servers)
	})

	it('persists so the offline snapshot keeps the last-known set', () => {
		registry.add(connectedMember())
		registry.updateMcpServers('sess-1', servers)
		registry.remove('sess-1')

		const offline = store.listOfflineSince(new Date(Date.now() - 60_000))
		expect(offline.find((m) => m.memberId === 'mid-1')?.mcpServers).toEqual(servers)
	})

	it('returns false for an unknown session', () => {
		expect(registry.updateMcpServers('nope', servers)).toBe(false)
	})
})
