import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	PROTOCOL_VERSION,
	decode,
	encode,
	type HouseholdToMember,
	type MemberStatus,
	type MemberToHousehold,
	type MsgHandshake,
} from '@night/shared'
import type { Logger } from 'pino'
import type { MemberConfig } from './config.ts'

interface State {
	status: MemberStatus
	currentTask: string | null
	lastServerActivity: number
}

const BACKOFF_STEPS_MS = [1_000, 5_000, 30_000, 60_000]

export class HouseholdConnection {
	private ws: WebSocket | null = null
	private heartbeatTimer: NodeJS.Timeout | null = null
	private watchdogTimer: NodeJS.Timeout | null = null
	private shuttingDown = false
	private readonly state: State = {
		status: 'idle',
		currentTask: null,
		lastServerActivity: Date.now(),
	}

	constructor(
		private readonly config: MemberConfig,
		private readonly logger: Logger,
	) {}

	async run(): Promise<void> {
		let attempt = 0
		while (!this.shuttingDown) {
			try {
				await this.connectOnce()
				attempt = 0
			} catch (err) {
				this.logger.warn({ err }, 'connection failed')
			}
			if (this.shuttingDown) return
			const delay = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)]!
			this.logger.info({ delay_ms: delay }, 'reconnecting after backoff')
			attempt += 1
			await sleep(delay)
		}
	}

	stop(): void {
		this.shuttingDown = true
		this.clearTimers()
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.close(1000, 'shutdown')
		}
		this.ws = null
	}

	private connectOnce(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = this.config.householdUrl.replace(/\/$/, '') + '/ws/member'
			this.logger.info({ url }, 'connecting to household')

			const ws = new WebSocket(url, {
				headers: {
					Authorization: `Bearer ${this.config.householdAccessToken}`,
				},
			})
			this.ws = ws

			ws.on('open', () => {
				this.logger.info('ws open, sending handshake')
				this.sendHandshake()
			})

			ws.on('message', (data) => {
				this.state.lastServerActivity = Date.now()
				let msg: HouseholdToMember
				try {
					msg = decode<HouseholdToMember>(data.toString())
				} catch {
					this.logger.warn('received non-JSON from household')
					return
				}
				this.handleServerMessage(msg)
			})

			ws.on('close', (code, reason) => {
				this.logger.info({ code, reason: reason.toString() || undefined }, 'ws closed')
				this.clearTimers()
				this.ws = null
				resolve()
			})

			ws.on('error', (err) => {
				this.logger.warn({ err: err.message }, 'ws error')
				// 'close' fires next; resolve there.
				if (ws.readyState === WebSocket.CONNECTING) {
					reject(err)
				}
			})
		})
	}

	private send(msg: MemberToHousehold): void {
		const ws = this.ws
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			this.logger.warn({ type: msg.type }, 'cannot send: ws not open')
			return
		}
		ws.send(encode(msg))
	}

	private sendHandshake(): void {
		const handshake: MsgHandshake = {
			type: 'handshake',
			protocol_version: PROTOCOL_VERSION,
			member_id: this.config.memberId,
			member_name: this.config.memberName,
			skills: this.config.skills,
			provider: this.config.provider,
			model: this.config.model,
			worker_profile: this.config.workerProfile,
		}
		this.send(handshake)
	}

	private handleServerMessage(msg: HouseholdToMember): void {
		switch (msg.type) {
			case 'handshake.ack':
				this.logger.info(
					{ household: msg.household_name, sessionId: msg.session_id },
					'handshake accepted',
				)
				this.startHeartbeat()
				this.send({ type: 'member.ready' })
				break
			case 'handshake.reject':
				this.logger.error({ reason: msg.reason }, 'handshake rejected, shutting down')
				this.shuttingDown = true
				this.ws?.close(4400, 'handshake_rejected')
				break
			case 'ping':
				this.send({ type: 'pong' })
				break
			case 'task.assigned':
				// TODO M2/M3: actual handling
				this.logger.info(
					{ task: msg.task.task_id, kind: msg.task.kind },
					'task assigned (stub)',
				)
				this.send({ type: 'task.ack', task_id: msg.task.task_id })
				this.state.status = 'busy'
				this.state.currentTask = msg.task.task_id
				break
			case 'task.cancel':
				this.logger.info({ task: msg.task_id, reason: msg.reason }, 'task cancel (stub)')
				this.state.status = 'idle'
				this.state.currentTask = null
				this.send({ type: 'task.failed', task_id: msg.task_id, reason: 'cancelled' })
				this.send({ type: 'member.ready' })
				break
			case 'task.rebase_suggested':
				this.logger.info(
					{ task: msg.task_id, behind_by: msg.behind_by },
					'rebase suggested (stub)',
				)
				break
			case 'events.replay_request':
				// M3 will read events.ndjson and replay.
				this.logger.debug(
					{ task: msg.task_id, from: msg.from_seq },
					'replay requested (stub)',
				)
				break
			default: {
				const _exhaustive: never = msg
				void _exhaustive
			}
		}
	}

	private startHeartbeat(): void {
		this.clearTimers()
		this.heartbeatTimer = setInterval(() => {
			this.send({
				type: 'heartbeat',
				status: this.state.status,
				current_task: this.state.currentTask,
			})
		}, HEARTBEAT_INTERVAL_MS)

		this.watchdogTimer = setInterval(() => {
			const since = Date.now() - this.state.lastServerActivity
			if (since > HEARTBEAT_TIMEOUT_MS) {
				this.logger.warn(
					{ since_ms: since },
					'no activity from household, closing ws to trigger reconnect',
				)
				this.ws?.close(4408, 'household_silent')
			}
		}, HEARTBEAT_INTERVAL_MS)
	}

	private clearTimers(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer)
			this.watchdogTimer = null
		}
	}
}
