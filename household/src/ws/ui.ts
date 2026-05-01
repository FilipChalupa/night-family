import { PROTOCOL_VERSION } from '@night/shared'
import type { WSContext } from 'hono/ws'
import type { Logger } from 'pino'
import { getSessionIdFromCookieHeader } from '../auth/oauth.ts'
import type { SessionStore } from '../auth/sessions.ts'
import type { MemberRegistry } from '../members/registry.ts'
import type { TaskStore } from '../tasks/store.ts'

export interface UiWsDeps {
	registry: MemberRegistry
	taskStore: TaskStore
	sessions: SessionStore
	requireUiLogin: boolean
	logger: Logger
}

/**
 * Web UI live updates. Pushes:
 *   - initial snapshot of members + tasks
 *   - registry events (member connected / disconnected / updated)
 *   - task events (created / updated / deleted)
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
						members: deps.registry.list(),
						tasks: deps.taskStore.list(),
					}),
				)

				unsubscribers.push(
					deps.registry.on((event) => ws.send(JSON.stringify(event))),
					deps.taskStore.on((event) => ws.send(JSON.stringify(event))),
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
