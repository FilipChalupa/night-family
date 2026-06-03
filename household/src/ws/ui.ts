import { PROTOCOL_VERSION } from '@night/shared'
import type { WSContext } from 'hono/ws'
import type { Logger } from 'pino'
import { getSessionIdFromCookieHeader } from '../auth/oauth.ts'
import type { SessionStore } from '../auth/sessions.ts'
import type { MemberRegistry } from '../members/registry.ts'
import { buildMembersSnapshot } from '../members/snapshot.ts'
import type { MemberStateStore } from '../members/store.ts'
import type { TaskEventLog } from '../tasks/eventLog.ts'
import type { TaskStore } from '../tasks/store.ts'

export interface UiWsDeps {
	registry: MemberRegistry
	memberStore: MemberStateStore
	taskStore: TaskStore
	eventLog: TaskEventLog
	sessions: SessionStore
	requireUiLogin: boolean
	logger: Logger
}

/**
 * Web UI live updates. Pushes:
 *   - initial snapshot of members + tasks
 *   - registry events (member connected / disconnected / updated)
 *   - task record events (created / updated / deleted)
 *   - task-log events (`task.event`) as agents emit them, so an open
 *     task-events view updates live
 *
 * When REQUIRE_UI_LOGIN=true, /ws/ui requires a valid session cookie.
 */
export function createUiWsHandler(deps: UiWsDeps) {
	return (c: { req: { header: (name: string) => string | undefined } }) => {
		const sessionId = getSessionIdFromCookieHeader(c.req.header('cookie'))
		const session = sessionId ? deps.sessions.get(sessionId) : null
		let unsubscribers: Array<() => void> = []

		return {
			onOpen: (_evt: unknown, ws: WSContext<unknown>) => {
				if (deps.requireUiLogin && !session) {
					ws.close(4401, 'not_authenticated')
					return
				}
				deps.logger.debug('ui ws opened')

				ws.send(
					JSON.stringify({
						type: 'snapshot',
						protocolVersion: PROTOCOL_VERSION,
						members: buildMembersSnapshot(deps.registry, deps.memberStore),
						tasks: deps.taskStore.list(),
					}),
				)

				unsubscribers.push(
					deps.registry.on((event) => ws.send(JSON.stringify(event))),
					deps.taskStore.on((event) => ws.send(JSON.stringify(event))),
					deps.eventLog.on((event) =>
						ws.send(
							JSON.stringify({
								type: 'task.event',
								taskId: event.taskId,
								event: {
									seq: event.seq,
									ts: event.ts.toISOString(),
									kind: event.kind,
									memberId: event.memberId,
									payload: event.payload,
								},
							}),
						),
					),
				)
			},
			onClose: () => {
				for (const u of unsubscribers) u()
				unsubscribers = []
				deps.logger.debug('ui ws closed')
			},
			onError: (err: unknown) => {
				deps.logger.error({ err }, 'ui ws error')
			},
		}
	}
}
