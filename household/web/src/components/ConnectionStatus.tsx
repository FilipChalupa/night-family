import { Chip, Tooltip } from '@mui/material'
import CloudDoneIcon from '@mui/icons-material/CloudDone'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import SyncIcon from '@mui/icons-material/Sync'
import { useEffect, useState } from 'react'
import { STALE_AFTER_MS } from '../hooks/useUiStream.ts'

interface Props {
	connected: boolean
	lastMessageAt: number | null
}

/**
 * Tick rate for the staleness check. Coarse enough that a sleeping mobile
 * tab doesn't burn battery, fast enough that the user sees the chip flip
 * within a few seconds of crossing the threshold.
 */
const TICK_MS = 10_000

/**
 * Status chip showing the live-data link to the household. Four states:
 *   - `online`       — WS open, recent message.
 *   - `stale`        — WS open but no message in `STALE_AFTER_MS`. Link is
 *                       silently broken; data on screen could be stale.
 *   - `reconnecting` — browser online but WS is dropped (auto-reconnect).
 *   - `offline`      — `navigator.onLine` is false.
 *
 * Standalone PWAs hide the browser's own network indicator, so without this
 * the dashboard could silently freeze with no visible explanation.
 */
export function ConnectionStatus({ connected, lastMessageAt }: Props) {
	const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
	// Force a periodic re-render so the staleness check sees fresh `Date.now()`.
	const [, setTick] = useState(0)

	useEffect(() => {
		const handleOnline = () => setOnline(true)
		const handleOffline = () => setOnline(false)
		window.addEventListener('online', handleOnline)
		window.addEventListener('offline', handleOffline)
		const interval = window.setInterval(() => setTick((n) => n + 1), TICK_MS)
		return () => {
			window.removeEventListener('online', handleOnline)
			window.removeEventListener('offline', handleOffline)
			window.clearInterval(interval)
		}
	}, [])

	if (!online) {
		return (
			<Tooltip title="Browser reports no network. Live updates paused — data on screen may be stale.">
				<Chip
					icon={<CloudOffIcon />}
					label="offline"
					size="small"
					color="error"
					variant="outlined"
				/>
			</Tooltip>
		)
	}

	if (!connected) {
		return (
			<Tooltip title="Lost connection to household. Reconnecting…">
				<Chip
					icon={<SyncIcon />}
					label="reconnecting…"
					size="small"
					color="warning"
					variant="outlined"
				/>
			</Tooltip>
		)
	}

	const isStale = lastMessageAt !== null && Date.now() - lastMessageAt > STALE_AFTER_MS
	if (isStale) {
		const seconds = Math.round((Date.now() - lastMessageAt!) / 1000)
		return (
			<Tooltip
				title={`Socket open but no updates in ${seconds}s. Forcing a reconnect — data on screen could be stale until it lands.`}
			>
				<Chip
					icon={<HourglassEmptyIcon />}
					label="no updates"
					size="small"
					color="warning"
					variant="outlined"
				/>
			</Tooltip>
		)
	}

	return (
		<Tooltip title="Live updates from household are flowing.">
			<Chip
				icon={<CloudDoneIcon />}
				label="online"
				size="small"
				color="success"
				variant="outlined"
			/>
		</Tooltip>
	)
}
