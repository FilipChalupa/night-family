import { useEffect, useRef, useState } from 'react'
import type { MemberSnapshot, TaskRecord, UiEvent } from '../types.ts'

/**
 * The household sends messages at least every ~10s (member heartbeats). If
 * we go this long without any traffic on a "open" socket, the link is
 * silently broken (e.g. NAT timeout, server hung) and we force-reconnect.
 * Shared with the connection-status chip so both agree on what "stale"
 * means.
 */
export const STALE_AFTER_MS = 90_000
const STALE_CHECK_INTERVAL_MS = 10_000

export function useUiStream(enabled: boolean): {
	members: MemberSnapshot[]
	tasks: TaskRecord[]
	connected: boolean
	householdProtocolVersion: string | null
	/**
	 * Wall-clock time (ms since epoch) the WebSocket last received any message.
	 * `null` until the first message arrives. Lets the UI flag a stale
	 * connection — socket nominally open but server stopped sending.
	 */
	lastMessageAt: number | null
} {
	const [members, setMembers] = useState<MemberSnapshot[]>([])
	const [tasks, setTasks] = useState<TaskRecord[]>([])
	const [connected, setConnected] = useState(false)
	const [householdProtocolVersion, setHouseholdProtocolVersion] = useState<string | null>(null)
	const [lastMessageAt, setLastMessageAt] = useState<number | null>(null)
	const wsRef = useRef<WebSocket | null>(null)
	const reconnectTimer = useRef<number | null>(null)
	const closedManually = useRef(false)
	// Mirror of `lastMessageAt` for the watchdog timer to read synchronously
	// without depending on React state propagation. Reset on `open` so the
	// new connection gets a full quiet-window before being torn down again.
	const lastTrafficAtRef = useRef<number | null>(null)

	useEffect(() => {
		if (!enabled) {
			setConnected(false)
			setMembers([])
			setTasks([])
			setLastMessageAt(null)
			lastTrafficAtRef.current = null
			closedManually.current = true
			wsRef.current?.close()
			if (reconnectTimer.current !== null) {
				window.clearTimeout(reconnectTimer.current)
				reconnectTimer.current = null
			}
			return
		}

		closedManually.current = false
		const open = () => {
			const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
			const url = `${proto}//${window.location.host}/ws/ui`
			const ws = new WebSocket(url)
			wsRef.current = ws

			ws.addEventListener('open', () => {
				setConnected(true)
				// Give the new connection a full quiet-window before the
				// staleness watchdog can act on it — otherwise a 95s-stale
				// reconnect would close the fresh socket before the first
				// snapshot has a chance to land.
				lastTrafficAtRef.current = Date.now()
			})

			ws.addEventListener('message', (evt) => {
				let msg: UiEvent
				try {
					msg = JSON.parse(evt.data) as UiEvent
				} catch {
					return
				}
				const now = Date.now()
				lastTrafficAtRef.current = now
				setLastMessageAt(now)
				switch (msg.type) {
					case 'snapshot':
						setMembers(msg.members)
						setTasks(msg.tasks)
						setHouseholdProtocolVersion(msg.protocolVersion)
						break
					case 'member.connected':
					case 'member.updated':
						setMembers((prev) => upsert(prev, msg.member, (m) => m.sessionId))
						break
					case 'member.disconnected':
						setMembers((prev) =>
							prev.map((m) =>
								m.sessionId === msg.sessionId
									? { ...m, status: 'offline', currentTask: null }
									: m,
							),
						)
						break
					case 'task.created':
					case 'task.updated':
						setTasks((prev) => upsert(prev, msg.task, (t) => t.id))
						break
					case 'task.deleted':
						setTasks((prev) => prev.filter((t) => t.id !== msg.taskId))
						break
				}
			})

			const scheduleReconnect = () => {
				setConnected(false)
				if (closedManually.current) return
				if (reconnectTimer.current !== null) return
				reconnectTimer.current = window.setTimeout(() => {
					reconnectTimer.current = null
					open()
				}, 1500)
			}

			ws.addEventListener('close', scheduleReconnect)
			ws.addEventListener('error', () => {
				ws.close()
			})
		}

		open()

		// Watchdog: if the socket is "open" but quiet for STALE_AFTER_MS,
		// force-close it. The `close` handler reconnects on the existing
		// 1.5s timer, and the new socket will pull a fresh `snapshot` —
		// no manual page reload required.
		const watchdog = window.setInterval(() => {
			const ws = wsRef.current
			const last = lastTrafficAtRef.current
			if (!ws || ws.readyState !== WebSocket.OPEN) return
			if (last === null) return
			if (Date.now() - last > STALE_AFTER_MS) {
				ws.close()
			}
		}, STALE_CHECK_INTERVAL_MS)

		return () => {
			closedManually.current = true
			window.clearInterval(watchdog)
			if (reconnectTimer.current !== null) {
				window.clearTimeout(reconnectTimer.current)
			}
			wsRef.current?.close()
		}
	}, [enabled])

	return { members, tasks, connected, householdProtocolVersion, lastMessageAt }
}

function upsert<T>(prev: T[], item: T, key: (x: T) => string): T[] {
	const k = key(item)
	const idx = prev.findIndex((x) => key(x) === k)
	if (idx === -1) return [item, ...prev]
	const next = prev.slice()
	next[idx] = item
	return next
}
