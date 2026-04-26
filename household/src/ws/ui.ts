import type { WSContext } from 'hono/ws'
import type { Logger } from 'pino'
import type { MemberRegistry } from '../members/registry.ts'
import type { TaskStore } from '../tasks/store.ts'

export interface UiWsDeps {
	registry: MemberRegistry
	taskStore: TaskStore
	logger: Logger
}

/**
 * Web UI live updates. Pushes:
 *   - initial snapshot of members + tasks
 *   - registry events (member connected / disconnected / updated)
 *   - task events (created / updated / deleted)
 *
 * Auth (session cookie) for /ws/ui will be added alongside CSRF — for now
 * we accept any connection. Don't expose Household publicly without a proxy.
 */
export function createUiWsHandler(deps: UiWsDeps) {
	return () => {
		let unsubscribers: Array<() => void> = []

		return {
			onOpen: (_evt: unknown, ws: WSContext<unknown>) => {
				deps.logger.debug('ui ws opened')

				ws.send(
					JSON.stringify({
						type: 'snapshot',
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
