import { createContext, useContext } from 'react'
import type { CurrentUser, MemberSnapshot, TaskKind, TaskRecord } from './types.ts'

export interface Health {
	status: string
	household: string
	uptimeSec: number
	members: number
}

export interface AppData {
	me: CurrentUser
	health: Health | null
	members: MemberSnapshot[]
	tasks: TaskRecord[]
	connected: boolean
	/** Wall-clock time (ms) of the last WS message; null until the first arrives. */
	lastMessageAt: number | null
	householdProtocolVersion: string | null
	isAdmin: boolean
	canSeeUsers: boolean
	createTask: (input: {
		kind: TaskKind
		title: string
		description: string
		repo: string | null
		metadata?: Record<string, unknown>
	}) => Promise<void>
	cancelTask: (id: string) => Promise<void>
	retryTask: (id: string) => Promise<void>
}

const AppContext = createContext<AppData | null>(null)

export function AppDataProvider({
	value,
	children,
}: {
	value: AppData
	children: React.ReactNode
}) {
	return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useAppData(): AppData {
	const v = useContext(AppContext)
	if (!v) throw new Error('useAppData must be used inside AppDataProvider')
	return v
}
