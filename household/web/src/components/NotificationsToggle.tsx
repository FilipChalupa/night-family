import { Button, Tooltip } from '@mui/material'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import NotificationsIcon from '@mui/icons-material/Notifications'
import NotificationsOffIcon from '@mui/icons-material/NotificationsOff'
import { useEffect, useState } from 'react'
import { hasPushSubscription, subscribeToPush, unsubscribeFromPush } from '../pushSubscribe.ts'
import { useSnackbar } from './Snackbar.tsx'

type Permission = 'default' | 'granted' | 'denied' | 'unsupported'

function readPermission(): Permission {
	if (typeof Notification === 'undefined') return 'unsupported'
	return Notification.permission
}

/**
 * Header button for desktop notifications. Two responsibilities:
 *   1. Request the browser-level Notification permission (gated by user
 *      gesture — Chromium dings sites that prompt without one).
 *   2. Once granted, subscribe to server-driven Web Push so notifications
 *      keep flowing even when the dashboard tab is closed.
 *
 * State machine:
 *   permission=default        → "Enable notifications"
 *   permission=granted, !sub  → "Subscribe to push"
 *   permission=granted, sub   → "Push on" (click to unsubscribe)
 *   permission=denied         → muted, disabled, tooltip-only
 *   unsupported               → nothing rendered
 */
export function NotificationsToggle() {
	const [perm, setPerm] = useState<Permission>(() => readPermission())
	const [subscribed, setSubscribed] = useState<boolean | null>(null)
	const [busy, setBusy] = useState(false)
	const snackbar = useSnackbar()

	useEffect(() => {
		if (typeof navigator === 'undefined' || !navigator.permissions) return
		let cancelled = false
		navigator.permissions
			.query({ name: 'notifications' as PermissionName })
			.then((status) => {
				if (cancelled) return
				const sync = () => setPerm(readPermission())
				status.addEventListener('change', sync)
				sync()
			})
			.catch(() => undefined)
		return () => {
			cancelled = true
		}
	}, [])

	useEffect(() => {
		if (perm !== 'granted') {
			setSubscribed(null)
			return
		}
		let cancelled = false
		hasPushSubscription().then((s) => {
			if (!cancelled) setSubscribed(s)
		})
		return () => {
			cancelled = true
		}
	}, [perm])

	if (perm === 'unsupported') return null

	if (perm === 'denied') {
		return (
			<Tooltip title="Notifications were blocked. Re-enable them in your browser's site settings.">
				<span>
					<Button
						variant="outlined"
						size="small"
						startIcon={<NotificationsOffIcon />}
						disabled
					>
						Notifications blocked
					</Button>
				</span>
			</Tooltip>
		)
	}

	if (perm === 'default') {
		return (
			<Button
				variant="outlined"
				size="small"
				startIcon={<NotificationsActiveIcon />}
				disabled={busy}
				onClick={() => {
					setBusy(true)
					void Notification.requestPermission()
						.then(async (next) => {
							setPerm(next)
							if (next === 'granted') {
								const sub = await subscribeToPush()
								setSubscribed(sub !== null)
							}
						})
						.catch((err) => snackbar.showError(err, 'Failed to enable notifications'))
						.finally(() => setBusy(false))
				}}
			>
				Enable notifications
			</Button>
		)
	}

	// permission === 'granted'
	if (subscribed === false) {
		return (
			<Button
				variant="outlined"
				size="small"
				startIcon={<NotificationsIcon />}
				disabled={busy}
				onClick={() => {
					setBusy(true)
					void subscribeToPush()
						.then((sub) => setSubscribed(sub !== null))
						.catch((err) => snackbar.showError(err, 'Failed to subscribe to push'))
						.finally(() => setBusy(false))
				}}
			>
				Subscribe to push
			</Button>
		)
	}
	if (subscribed === true) {
		return (
			<Tooltip title="Receiving notifications even when the tab is closed. Click to stop.">
				<Button
					variant="outlined"
					size="small"
					color="primary"
					startIcon={<NotificationsActiveIcon />}
					disabled={busy}
					onClick={() => {
						setBusy(true)
						void unsubscribeFromPush()
							.then(() => setSubscribed(false))
							.catch((err) => snackbar.showError(err, 'Failed to unsubscribe'))
							.finally(() => setBusy(false))
					}}
				>
					Push on
				</Button>
			</Tooltip>
		)
	}
	return null
}
