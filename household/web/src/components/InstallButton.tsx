import { Button } from '@mui/material'
import InstallMobileIcon from '@mui/icons-material/InstallMobile'
import { usePWAInstall } from 'react-use-pwa-install'

/**
 * "Install" button surfaced in the header. The hook returns a callable when
 * the browser fired `beforeinstallprompt` (i.e. the PWA is installable and
 * not already installed); otherwise it returns null and we render nothing.
 *
 * Without this button the install affordance is buried in the browser's own
 * menu — most users never find it.
 */
export function InstallButton() {
	const install = usePWAInstall()
	if (!install) return null
	return (
		<Button
			variant="outlined"
			size="small"
			startIcon={<InstallMobileIcon />}
			onClick={() => {
				void install()
			}}
		>
			Install
		</Button>
	)
}
