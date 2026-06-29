import type { Logger } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAccessibleRepos, type MemberConfig } from './config.ts'
import { HouseholdConnection, type ConnectionDeps } from './connection.ts'

// Stub the GitHub call so refreshRepos is exercised without network.
vi.mock('./config.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return { ...actual, fetchAccessibleRepos: vi.fn() }
})

const fetchMock = vi.mocked(fetchAccessibleRepos)

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
	trace: () => {},
	fatal: () => {},
	level: 'silent',
	child: () => silentLogger,
} as unknown as Logger

/** Private surface we drive directly — refreshRepos has no public trigger without a live WS. */
interface ConnectionInternals {
	refreshRepos(reason: string): Promise<void>
	currentRepos: string[]
}

function makeConnection() {
	const config = { repos: ['o/seed'], githubPat: 'pat' } as unknown as MemberConfig
	const deps = { taskRunner: {} } as unknown as ConnectionDeps
	const conn = new HouseholdConnection(config, silentLogger, deps)
	// send() needs an open WS; replace it with a spy so we can assert the wire
	// messages without standing up a socket.
	const send = vi.spyOn(conn, 'send').mockReturnValue(true)
	return { conn: conn as unknown as ConnectionInternals, send }
}

afterEach(() => {
	vi.clearAllMocks()
})

describe('HouseholdConnection.refreshRepos', () => {
	it('coalesces concurrent refreshes into one fetch and one member.repos', async () => {
		const { conn, send } = makeConnection()
		fetchMock.mockResolvedValue(['o/a', 'o/b'])

		const p1 = conn.refreshRepos('manual')
		const p2 = conn.refreshRepos('queue_mismatch')
		expect(p1).toBe(p2) // same in-flight promise — second call is coalesced
		await Promise.all([p1, p2])

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(send).toHaveBeenCalledWith({ type: 'member.repos', repos: ['o/a', 'o/b'] })
		expect(send).toHaveBeenCalledTimes(1)
		expect(conn.currentRepos).toEqual(['o/a', 'o/b'])
	})

	it('re-fetches once the in-flight refresh has settled', async () => {
		const { conn } = makeConnection()
		fetchMock.mockResolvedValue(['o/a'])

		await conn.refreshRepos('manual')
		await conn.refreshRepos('periodic')

		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('on failure emits member.repos_error and keeps the cached list', async () => {
		const { conn, send } = makeConnection()
		fetchMock.mockRejectedValue(new Error('rate limited'))

		await conn.refreshRepos('periodic')

		expect(send).toHaveBeenCalledWith({
			type: 'member.repos_error',
			reason: 'periodic',
			error: 'rate limited',
		})
		expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'member.repos' }))
		// Cached list from construction is preserved.
		expect(conn.currentRepos).toEqual(['o/seed'])
	})
})
