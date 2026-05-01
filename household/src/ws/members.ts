import { randomUUID } from 'node:crypto'
import type { WSContext } from 'hono/ws'
import {
	PING_INTERVAL_MS,
	PROTOCOL_VERSION,
	compareProtocolVersions,
	encode,
	parseMemberToHousehold,
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
		let pingTimer: NodeJS.Timeout | null = null

		const send = (ws: WSContext<unknown>, msg: HouseholdToMember) => {
			ws.send(encode(msg))
		}

		const stopPings = () => {
			if (pingTimer) {
				clearInterval(pingTimer)
				pingTimer = null
			}
		}

		// Member's connection-level watchdog closes the WS after ~120s of total
		// silence from Household. While a Member is grinding through a long
		// agent loop we don't have any natural traffic to send, so we explicitly
		// ping every PING_INTERVAL_MS to keep its `lastServerActivity` fresh.
		// Member replies with `pong`, which is also fine — the timer just needs
		// any outbound message to land.
		const startPings = (ws: WSContext<unknown>) => {
			stopPings()
			pingTimer = setInterval(() => {
				try {
					send(ws, { type: 'ping' })
				} catch {
					/* socket already closed */
				}
			}, PING_INTERVAL_MS)
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

				const parsed = parseMemberToHousehold(String(evt.data))
				if (!parsed.ok) {
					deps.logger.warn(
						{ error: parsed.error, sessionId: session?.sessionId },
						'dropping malformed member message',
					)
					return
				}
				const msg: MemberToHousehold = parsed.msg

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
					if (session) startPings(ws)
					return
				}

				routeMemberMessage(msg, session, deps)
			},

			onClose: (_evt: unknown, _ws: WSContext<unknown>) => {
				stopPings()
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
	const compat = compareProtocolVersions(PROTOCOL_VERSION, msg.protocol_version)
	if (compat === 'major-mismatch') {
		send(ws, {
			type: 'handshake.reject',
			reason: `protocol_major_mismatch (server=${PROTOCOL_VERSION}, client=${msg.protocol_version})`,
		})
		ws.close(4400, 'protocol_major_mismatch')
		return null
	}
	if (compat === 'minor-skew') {
		// Minor bumps are contractually additive (see README §Protocol versioning),
		// so the connection is safe — but we want this visible in production
		// because it's the earliest signal that part of the fleet is lagging
		// (or running ahead of) Household.
		deps.logger.warn(
			{
				server: PROTOCOL_VERSION,
				client: msg.protocol_version,
				memberId: msg.member_id,
			},
			'protocol minor version skew between household and member',
		)
	}

	const sessionId = randomUUID()

	// Supersede any zombie sessions for the same member_id. When a Member is
	// killed ungracefully (kill -9, network drop, dev-server restart) the old
	// WS may linger in the registry until the watchdog notices, and the new
	// connection would otherwise show up as a duplicate row in the dashboard.
	// The new handshake is proof the old session is dead — evict it now.
	//
	// Tasks the new session declares via `resumes` are kept assigned (just
	// re-linked to the new sessionId); anything else gets requeued so a
	// healthy member can pick it up.
	const retainedTaskIds = new Set((msg.resumes ?? []).map((r) => r.task_id))
	const newAssignment = {
		sessionId,
		memberId: msg.member_id,
		memberName: msg.member_name,
	}
	for (const stale of deps.registry.findByMemberId(msg.member_id)) {
		deps.logger.info(
			{
				staleSessionId: stale.sessionId,
				memberId: msg.member_id,
				retainedTaskIds: [...retainedTaskIds],
			},
			'superseding previous session for member',
		)
		deps.dispatcher.onMemberSuperseded(stale.sessionId, newAssignment, retainedTaskIds)
		deps.registry.remove(stale.sessionId)
		try {
			stale.close(4409, 'superseded')
		} catch {
			/* old socket already closed */
		}
	}

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
		protocolVersion: msg.protocol_version,
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
		protocol_version: PROTOCOL_VERSION,
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
