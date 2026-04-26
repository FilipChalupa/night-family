import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	PROTOCOL_VERSION,
	decode,
	encode,
	type AssignedTask,
	type HouseholdToMember,
	type MemberStatus,
	type MemberToHousehold,
	type MsgEvent,
	type MsgHandshake,
	type ResumeRef,
} from '@night/shared'
import type { Logger } from 'pino'
import type { MemberConfig } from './config.ts'
import type { TaskRunner } from './tasks/runner.ts'
import { EventBuffer, eventFilePath } from './tasks/eventBuffer.ts'

interface State {
	status: MemberStatus
	currentTask: string | null
	lastServerActivity: number
}

const BACKOFF_STEPS_MS = [1_000, 5_000, 30_000, 60_000]

export interface ConnectionDeps {
	taskRunner: TaskRunner
}

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
		private readonly deps: ConnectionDeps,
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
		this.deps.taskRunner.cancel('shutdown')
		this.clearTimers()
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.close(1000, 'shutdown')
		}
		this.ws = null
	}

	/**
	 * Send a wire message. Returns true if the WS is open and the bytes were
	 * queued (they may still be lost on connection drop, but the EventBuffer
	 * watermark is updated optimistically and corrected via replay).
	 */
	send(msg: MemberToHousehold): boolean {
		const ws = this.ws
		if (!ws || ws.readyState !== WebSocket.OPEN) return false
		ws.send(encode(msg))
		return true
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
				void this.sendHandshake()
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
				void this.handleServerMessage(msg)
			})

			ws.on('close', (code, reason) => {
				this.logger.info({ code, reason: reason.toString() || undefined }, 'ws closed')
				this.clearTimers()
				this.ws = null
				resolve()
			})

			ws.on('error', (err) => {
				this.logger.warn({ err: err.message }, 'ws error')
				if (ws.readyState === WebSocket.CONNECTING) {
					reject(err)
				}
			})
		})
	}

	private async buildResumes(): Promise<ResumeRef[]> {
		const taskId = this.state.currentTask
		if (!taskId) return []
		const buffer = new EventBuffer(taskId, eventFilePath(this.config.workspaceDir, taskId))
		await buffer.load()
		return [{ task_id: taskId, last_seq: buffer.watermark }]
	}

	private async sendHandshake(): Promise<void> {
		const resumes = await this.buildResumes()
		const handshake: MsgHandshake = {
			type: 'handshake',
			protocol_version: PROTOCOL_VERSION,
			member_id: this.config.memberId,
			member_name: this.config.memberName,
			skills: this.config.skills,
			provider: this.config.provider,
			model: this.config.model,
			worker_profile: this.config.workerProfile,
			...(resumes.length > 0 ? { resumes } : {}),
		}
		this.send(handshake)
	}

	private async handleServerMessage(msg: HouseholdToMember): Promise<void> {
		switch (msg.type) {
			case 'handshake.ack':
				this.logger.info(
					{ household: msg.household_name, sessionId: msg.session_id },
					'handshake accepted',
				)
				this.startHeartbeat()
				if (this.state.currentTask === null) {
					this.send({ type: 'member.ready' })
				} else {
					this.send({
						type: 'member.busy',
						task_id: this.state.currentTask,
					})
				}
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
				this.send({ type: 'task.ack', task_id: msg.task.task_id })
				this.state.status = 'busy'
				this.state.currentTask = msg.task.task_id
				this.startTaskRun(msg.task, msg.github_token, msg.repo_url)
				break
			case 'task.cancel':
				this.logger.info({ task: msg.task_id, reason: msg.reason }, 'task cancel received')
				this.deps.taskRunner.cancel(msg.reason)
				break
			case 'task.rebase_suggested':
				this.logger.info(
					{ task: msg.task_id, behind_by: msg.behind_by },
					'rebase suggested (M5)',
				)
				break
			case 'events.replay_request':
				await this.replayEvents(msg.task_id, msg.from_seq)
				break
			default: {
				const _exhaustive: never = msg
				void _exhaustive
			}
		}
	}

	private startTaskRun(task: AssignedTask, githubToken: string, repoUrl: string): void {
		const runPromise = this.deps.taskRunner
			.run({
				taskId: task.task_id,
				kind: task.kind,
				title: task.title,
				description: task.description,
				repo: task.repo ?? null,
				githubToken,
				repoUrl,
			})
			.then((outcome) => {
				if (outcome.type === 'completed') {
					this.send({
						type: 'task.completed',
						task_id: task.task_id,
						result: outcome.result ?? null,
						...(outcome.prUrl ? { pr_url: outcome.prUrl } : {}),
					})
				} else {
					this.send({
						type: 'task.failed',
						task_id: task.task_id,
						reason: outcome.reason ?? 'unknown',
					})
				}
			})
			.catch((err) => {
				this.logger.error({ err }, 'task runner threw — sending task.failed')
				this.send({
					type: 'task.failed',
					task_id: task.task_id,
					reason: 'runner_crash:' + (err instanceof Error ? err.message : String(err)),
				})
			})
			.finally(() => {
				this.state.status = 'idle'
				this.state.currentTask = null
				this.send({ type: 'member.ready' })
			})
		void runPromise
	}

	private async replayEvents(taskId: string, fromSeq: number): Promise<void> {
		this.logger.info({ taskId, fromSeq }, 'replaying events')
		const buffer = new EventBuffer(taskId, eventFilePath(this.config.workspaceDir, taskId))
		await buffer.load()
		let count = 0
		for await (const ev of buffer.iterFrom(fromSeq)) {
			const sent = this.send(ev as MsgEvent)
			if (!sent) {
				this.logger.warn({ taskId, seq: ev.seq }, 'replay aborted (ws not open)')
				return
			}
			buffer.markSent(ev.seq)
			count++
		}
		this.logger.info({ taskId, count }, 'replay complete')
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
