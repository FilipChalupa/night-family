import { Alert, Button, Snackbar } from '@mui/material'
import { useEffect, useState } from 'react'
import { onServiceWorkerUpdate } from '../registerSW.ts'

/**
 * Snackbar that appears when a new service worker has finished installing in
 * the background (i.e. a deploy landed). Clicking Reload posts SKIP_WAITING
 * to the waiting worker; `registerSW.ts` handles the resulting hard reload.
 */
export function UpdateToast() {
	const [reload, setReload] = useState<(() => void) | null>(null)

	useEffect(() => {
		return onServiceWorkerUpdate((r) => {
			// Wrap in arrow so React doesn't unwrap the function via the
			// "lazy state init" rule when stored directly.
			setReload(() => r)
		})
	}, [])

	return (
		<Snackbar
			open={reload !== null}
			anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
		>
			<Alert
				severity="info"
				variant="filled"
				action={
					<Button
						color="inherit"
						size="small"
						onClick={() => {
							reload?.()
						}}
					>
						Reload
					</Button>
				}
			>
				A new version is available — reload to apply.
			</Alert>
		</Snackbar>
	)
}
