import { Button, Tooltip } from '@mui/material'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import NotificationsOffIcon from '@mui/icons-material/NotificationsOff'
import { useEffect, useState } from 'react'

type Permission = 'default' | 'granted' | 'denied' | 'unsupported'

function read(): Permission {
	if (typeof Notification === 'undefined') return 'unsupported'
	return Notification.permission
}

/**
 * Header button for the user to opt into desktop notifications when an
 * agent task fails or a PR becomes ready for merge. We never auto-prompt —
 * Chromium dings sites that ask without a user gesture.
 *
 *   - `default`     → "Enable notifications" button.
 *   - `denied`      → muted icon with tooltip explaining the browser blocked it.
 *   - `granted`     → nothing rendered (no need for permanent UI noise).
 *   - `unsupported` → nothing rendered.
 */
export function NotificationsToggle() {
	const [perm, setPerm] = useState<Permission>(() => read())

	// Some browsers expose permission changes via the Permissions API.
	useEffect(() => {
		if (typeof navigator === 'undefined' || !navigator.permissions) return
		let cancelled = false
		navigator.permissions
			.query({ name: 'notifications' as PermissionName })
			.then((status) => {
				if (cancelled) return
				const sync = () => setPerm(read())
				status.addEventListener('change', sync)
				sync()
			})
			.catch(() => undefined)
		return () => {
			cancelled = true
		}
	}, [])

	if (perm === 'unsupported' || perm === 'granted') return null

	if (perm === 'denied') {
		return (
			<Tooltip title="Notifications were blocked. Re-enable them in your browser's site settings.">
				<span>
					<Button variant="outlined" size="small" startIcon={<NotificationsOffIcon />} disabled>
						Notifications blocked
					</Button>
				</span>
			</Tooltip>
		)
	}

	return (
		<Button
			variant="outlined"
			size="small"
			startIcon={<NotificationsActiveIcon />}
			onClick={() => {
				void Notification.requestPermission().then((next) => setPerm(next))
			}}
		>
			Enable notifications
		</Button>
	)
}
