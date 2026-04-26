import { randomUUID } from 'node:crypto'
import type { WSContext } from 'hono/ws'
import {
	PROTOCOL_VERSION,
	decode,
	encode,
	type HouseholdToMember,
	type MemberToHousehold,
	type MsgHandshake,
} from '@night/shared'
import type { Logger } from 'pino'
import type { MemberRegistry } from '../members/registry.ts'
import type { Dispatcher } from '../tasks/dispatcher.ts'
import type { TaskEventLog } from '../tasks/eventLog.ts'
import type { TokenStore } from '../tokens/auth.ts'

export interface MemberWsDeps {
	registry: MemberRegistry
	tokens: TokenStore
	dispatcher: Dispatcher
	eventLog: TaskEventLog
	householdName: string
	logger: Logger
}

interface SessionState {
	sessionId: string
	tokenId: string
	memberId: string
}

export function createMemberWsHandler(deps: MemberWsDeps) {
	return (c: { req: { header: (name: string) => string | undefined } }) => {
		const authHeader = c.req.header('authorization') ?? ''
		const presented = authHeader.toLowerCase().startsWith('bearer ')
			? authHeader.slice('bearer '.length).trim()
			: ''

		const tokenRecord = presented ? deps.tokens.validate(presented) : null
		const tokenId = tokenRecord?.id ?? null

		let session: SessionState | null = null

		const send = (ws: WSContext<unknown>, msg: HouseholdToMember) => {
			ws.send(encode(msg))
		}

		return {
			onOpen: (_evt: unknown, ws: WSContext<unknown>) => {
				if (!tokenId) {
					send(ws, { type: 'handshake.reject', reason: 'invalid_token' })
					ws.close(4401, 'invalid_token')
					return
				}
				deps.logger.debug({ tokenId }, 'member ws opened, awaiting handshake')
			},

			onMessage: (evt: { data: unknown }, ws: WSContext<unknown>) => {
				if (!tokenId) return

				let msg: MemberToHousehold
				try {
					msg = decode<MemberToHousehold>(String(evt.data))
				} catch {
					deps.logger.warn('member sent invalid JSON')
					return
				}

				if (!session) {
					if (msg.type !== 'handshake') {
						send(ws, {
							type: 'handshake.reject',
							reason: 'expected_handshake_first',
						})
						ws.close(4400, 'expected_handshake_first')
						return
					}
					session = handleHandshake(msg, ws, tokenId, deps, send)
					return
				}

				routeMemberMessage(msg, session, deps)
			},

			onClose: (_evt: unknown, _ws: WSContext<unknown>) => {
				if (session) {
					deps.logger.info(
						{ sessionId: session.sessionId, memberId: session.memberId },
						'member disconnected',
					)
					deps.dispatcher.onMemberDisconnected(session.sessionId)
					deps.registry.remove(session.sessionId)
				}
			},

			onError: (err: unknown) => {
				deps.logger.error({ err }, 'member ws error')
			},
		}
	}
}

function handleHandshake(
	msg: MsgHandshake,
	ws: WSContext<unknown>,
	tokenId: string,
	deps: MemberWsDeps,
	send: (ws: WSContext<unknown>, msg: HouseholdToMember) => void,
): SessionState | null {
	if (msg.protocol_version !== PROTOCOL_VERSION) {
		send(ws, {
			type: 'handshake.reject',
			reason: `protocol_version_mismatch (server=${PROTOCOL_VERSION}, client=${msg.protocol_version})`,
		})
		ws.close(4400, 'protocol_version_mismatch')
		return null
	}

	const sessionId = randomUUID()

	// Replay protocol: ask Member to resend any events Household hasn't seen.
	for (const resume of msg.resumes ?? []) {
		const persistedMax = deps.eventLog.maxSeq(resume.task_id)
		const fromSeq = persistedMax + 1
		send(ws, {
			type: 'events.replay_request',
			task_id: resume.task_id,
			from_seq: fromSeq,
		})
		deps.logger.info(
			{
				taskId: resume.task_id,
				memberLastSeq: resume.last_seq,
				householdMaxSeq: persistedMax,
				fromSeq,
			},
			'replay requested',
		)
	}

	deps.registry.add({
		sessionId,
		memberId: msg.member_id,
		memberName: msg.member_name,
		skills: msg.skills,
		provider: msg.provider,
		model: msg.model,
		workerProfile: msg.worker_profile,
		tokenId,
		connectedAt: new Date(),
		status: 'idle',
		currentTask: null,
		lastHeartbeat: new Date(),
		send: (raw) => {
			ws.send(typeof raw === 'string' ? raw : JSON.stringify(raw))
		},
		close: (code, reason) => {
			ws.close(code, reason)
		},
	})

	deps.tokens.recordUsage(tokenId, {
		member_id: msg.member_id,
		member_name: msg.member_name,
		connected_at: new Date().toISOString(),
	})

	send(ws, {
		type: 'handshake.ack',
		household_name: deps.householdName,
		session_id: sessionId,
	})

	deps.logger.info(
		{
			sessionId,
			memberId: msg.member_id,
			memberName: msg.member_name,
			provider: msg.provider,
			model: msg.model,
			skills: msg.skills,
		},
		'member handshake ok',
	)

	return { sessionId, tokenId, memberId: msg.member_id }
}

function routeMemberMessage(
	msg: MemberToHousehold,
	session: SessionState,
	deps: MemberWsDeps,
): void {
	switch (msg.type) {
		case 'heartbeat':
			deps.registry.updateStatus(session.sessionId, msg.status, msg.current_task)
			break
		case 'pong':
			deps.registry.touch(session.sessionId)
			break
		case 'member.ready': {
			deps.registry.updateStatus(session.sessionId, 'idle', null)
			deps.logger.debug({ sessionId: session.sessionId }, 'member ready')
			const member = deps.registry.list().find((m) => m.sessionId === session.sessionId)
			if (member) deps.dispatcher.tryDispatchOne(member)
			break
		}
		case 'member.busy':
			deps.registry.updateStatus(session.sessionId, 'busy', msg.task_id)
			break
		case 'task.ack':
			deps.dispatcher.onAck(msg.task_id)
			break
		case 'task.completed':
			deps.dispatcher.onCompleted(msg.task_id, msg.result, msg.pr_url ?? null)
			break
		case 'task.failed':
			deps.dispatcher.onFailed(msg.task_id, msg.reason)
			break
		case 'event': {
			const member = deps.registry.get(session.sessionId)
			const inserted = deps.eventLog.insert({
				taskId: msg.task_id,
				seq: msg.seq,
				tsMs: Date.parse(msg.ts) || Date.now(),
				sessionId: session.sessionId,
				memberId: member?.memberId ?? null,
				kind: msg.kind,
				payload: msg.payload,
			})
			if (!inserted) {
				deps.logger.debug(
					{ taskId: msg.task_id, seq: msg.seq },
					'event dropped (duplicate from replay)',
				)
			}
			break
		}
		case 'handshake':
			deps.logger.warn({ sessionId: session.sessionId }, 'duplicate handshake ignored')
			break
		default: {
			const _exhaustive: never = msg
			void _exhaustive
		}
	}
}
