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

interface TaskInternals {
	handleServerMessage(msg: unknown): Promise<void>
	drain(timeoutMs: number): Promise<void>
}

function makeTaskConnection(run: Promise<unknown>, cancel = vi.fn()) {
	const config = { repos: [], githubPat: 'pat', workspaceDir: '/tmp' } as unknown as MemberConfig
	const taskRunner = { run: vi.fn().mockReturnValue(run), cancel } as unknown
	const deps = { taskRunner } as unknown as ConnectionDeps
	const conn = new HouseholdConnection(config, silentLogger, deps)
	const send = vi.spyOn(conn, 'send').mockReturnValue(true)
	return { conn: conn as unknown as TaskInternals, send, cancel }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function assignMsg(assignmentId?: string) {
	return {
		type: 'task.assigned',
		task: {
			task_id: 'T1',
			kind: 'implement',
			title: 't',
			description: 'd',
			...(assignmentId ? { assignment_id: assignmentId } : {}),
		},
	}
}

describe('HouseholdConnection assignment nonce', () => {
	it('echoes assignment_id on task.ack and task.completed', async () => {
		let resolveRun!: (v: unknown) => void
		const run = new Promise<unknown>((r) => (resolveRun = r))
		const { conn, send } = makeTaskConnection(run)

		await conn.handleServerMessage(assignMsg('N1'))
		expect(send).toHaveBeenCalledWith({ type: 'task.ack', task_id: 'T1', assignment_id: 'N1' })

		resolveRun({ type: 'completed', result: { ok: true } })
		await flush()
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'task.completed', task_id: 'T1', assignment_id: 'N1' }),
		)
	})

	it('omits assignment_id when the Household did not send one (older peer)', async () => {
		let resolveRun!: (v: unknown) => void
		const run = new Promise<unknown>((r) => (resolveRun = r))
		const { conn, send } = makeTaskConnection(run)

		await conn.handleServerMessage(assignMsg(undefined))
		expect(send).toHaveBeenCalledWith({ type: 'task.ack', task_id: 'T1' })

		resolveRun({ type: 'completed', result: {} })
		await flush()
		const completed = send.mock.calls
			.map((c) => c[0] as unknown as Record<string, unknown>)
			.find((m) => m.type === 'task.completed')!
		expect(completed).not.toHaveProperty('assignment_id')
	})

	it('re-acks a redispatch of the running task without starting a second run', async () => {
		const run = new Promise<unknown>(() => {}) // never settles
		const { conn, send, cancel } = makeTaskConnection(run)

		await conn.handleServerMessage(assignMsg('N1'))
		await conn.handleServerMessage(assignMsg('N2')) // same task, new nonce
		// Re-acked with the new nonce; no decline, no cancel of the running task.
		expect(send).toHaveBeenCalledWith({ type: 'task.ack', task_id: 'T1', assignment_id: 'N2' })
		expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'task.failed' }))
		expect(cancel).not.toHaveBeenCalled()
	})

	it('drain cancels the run and suppresses the terminal result + member.ready', async () => {
		let resolveRun!: (v: unknown) => void
		const run = new Promise<unknown>((r) => (resolveRun = r))
		// cancel() ends the run the way TaskRunner.cancel would.
		const cancel = vi.fn(() => resolveRun({ type: 'failed', reason: 'cancelled' }))
		const { conn, send } = makeTaskConnection(run, cancel)

		await conn.handleServerMessage(assignMsg('N1'))
		send.mockClear()

		await conn.drain(1000)
		expect(cancel).toHaveBeenCalledWith('shutdown')
		const types = send.mock.calls.map((c) => (c[0] as { type: string }).type)
		expect(types).not.toContain('task.failed')
		expect(types).not.toContain('member.ready')
	})
})
