import type { WSContext } from 'hono/ws'
import type { Logger } from 'pino'
import type { MemberRegistry, RegistryEvent } from '../members/registry.ts'

export interface UiWsDeps {
	registry: MemberRegistry
	logger: Logger
}

/**
 * Minimal UI WS — pushes member registry events. Auth (session cookie) is
 * enforced by an upstream middleware in M1; for now we accept any connection
 * and push everything. Tighten before exposing publicly.
 */
export function createUiWsHandler(deps: UiWsDeps) {
	return () => {
		let unsubscribe: (() => void) | null = null

		return {
			onOpen: (_evt: unknown, ws: WSContext<unknown>) => {
				deps.logger.debug('ui ws opened')

				ws.send(
					JSON.stringify({
						type: 'snapshot',
						members: deps.registry.list(),
					}),
				)

				unsubscribe = deps.registry.on((event: RegistryEvent) => {
					ws.send(JSON.stringify(event))
				})
			},
			onClose: () => {
				unsubscribe?.()
				unsubscribe = null
				deps.logger.debug('ui ws closed')
			},
			onError: (err: unknown) => {
				deps.logger.error({ err }, 'ui ws error')
			},
		}
	}
}
