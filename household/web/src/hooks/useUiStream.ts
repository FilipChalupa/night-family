import { useEffect, useRef, useState } from 'react'
import type { MemberSnapshot, TaskRecord, UiEvent } from '../types.ts'

export function useUiStream(): {
	members: MemberSnapshot[]
	tasks: TaskRecord[]
	connected: boolean
} {
	const [members, setMembers] = useState<MemberSnapshot[]>([])
	const [tasks, setTasks] = useState<TaskRecord[]>([])
	const [connected, setConnected] = useState(false)
	const wsRef = useRef<WebSocket | null>(null)
	const reconnectTimer = useRef<number | null>(null)
	const closedManually = useRef(false)

	useEffect(() => {
		const open = () => {
			const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
			const url = `${proto}//${window.location.host}/ws/ui`
			const ws = new WebSocket(url)
			wsRef.current = ws

			ws.addEventListener('open', () => setConnected(true))

			ws.addEventListener('message', (evt) => {
				let msg: UiEvent
				try {
					msg = JSON.parse(evt.data) as UiEvent
				} catch {
					return
				}
				switch (msg.type) {
					case 'snapshot':
						setMembers(msg.members)
						setTasks(msg.tasks)
						break
					case 'member.connected':
					case 'member.updated':
						setMembers((prev) => upsert(prev, msg.member, (m) => m.sessionId))
						break
					case 'member.disconnected':
						setMembers((prev) => prev.filter((m) => m.sessionId !== msg.sessionId))
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

		return () => {
			closedManually.current = true
			if (reconnectTimer.current !== null) {
				window.clearTimeout(reconnectTimer.current)
			}
			wsRef.current?.close()
		}
	}, [])

	return { members, tasks, connected }
}

function upsert<T>(prev: T[], item: T, key: (x: T) => string): T[] {
	const k = key(item)
	const idx = prev.findIndex((x) => key(x) === k)
	if (idx === -1) return [item, ...prev]
	const next = prev.slice()
	next[idx] = item
	return next
}
