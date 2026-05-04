import { Chip, Tooltip } from '@mui/material'
import CloudDoneIcon from '@mui/icons-material/CloudDone'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import SyncIcon from '@mui/icons-material/Sync'
import { useEffect, useState } from 'react'

interface Props {
	connected: boolean
}

/**
 * Tri-state badge showing the live-data link to the household:
 *   - `online`       — WS attached, snapshots flowing.
 *   - `reconnecting` — browser online but WS dropped (auto-reconnect in flight).
 *   - `offline`      — `navigator.onLine` is false.
 *
 * Standalone PWAs hide the browser's own network indicator, so without this
 * the dashboard could silently freeze with no visible explanation.
 */
export function ConnectionStatus({ connected }: Props) {
	const [online, setOnline] = useState(
		typeof navigator === 'undefined' ? true : navigator.onLine,
	)

	useEffect(() => {
		const handleOnline = () => setOnline(true)
		const handleOffline = () => setOnline(false)
		window.addEventListener('online', handleOnline)
		window.addEventListener('offline', handleOffline)
		return () => {
			window.removeEventListener('online', handleOnline)
			window.removeEventListener('offline', handleOffline)
		}
	}, [])

	if (connected && online) {
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
