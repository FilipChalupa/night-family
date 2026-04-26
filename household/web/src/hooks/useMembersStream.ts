import { useEffect, useRef, useState } from 'react'
import type { MemberSnapshot, RegistryEvent } from '../types.ts'

export function useMembersStream(): {
	members: MemberSnapshot[]
	connected: boolean
} {
	const [members, setMembers] = useState<MemberSnapshot[]>([])
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
				let msg: RegistryEvent
				try {
					msg = JSON.parse(evt.data) as RegistryEvent
				} catch {
					return
				}
				switch (msg.type) {
					case 'snapshot':
						setMembers(msg.members)
						break
					case 'member.connected':
						setMembers((prev) => upsert(prev, msg.member))
						break
					case 'member.updated':
						setMembers((prev) => upsert(prev, msg.member))
						break
					case 'member.disconnected':
						setMembers((prev) => prev.filter((m) => m.sessionId !== msg.sessionId))
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

	return { members, connected }
}

function upsert(prev: MemberSnapshot[], m: MemberSnapshot): MemberSnapshot[] {
	const idx = prev.findIndex((x) => x.sessionId === m.sessionId)
	if (idx === -1) return [...prev, m]
	const next = prev.slice()
	next[idx] = m
	return next
}
