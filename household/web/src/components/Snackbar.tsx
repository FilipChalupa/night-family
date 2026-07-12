import { Alert, Snackbar } from '@mui/material'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

type Severity = 'error' | 'success' | 'info' | 'warning'

interface Toast {
	message: string
	severity: Severity
}

interface SnackbarApi {
	show: (message: string, severity?: Severity) => void
	showError: (err: unknown, fallback?: string) => void
	showSuccess: (message: string) => void
}

const SnackbarContext = createContext<SnackbarApi | null>(null)

function errorMessage(err: unknown, fallback: string): string {
	if (err instanceof Error && err.message) return err.message
	if (typeof err === 'string' && err) return err
	return fallback
}

/**
 * App-wide transient feedback. Gives mutations a consistent place to surface
 * failures (previously they were dropped silently or shown via a native
 * `alert()`), and confirms one-off successes.
 */
export function SnackbarProvider({ children }: { children: ReactNode }) {
	const [toast, setToast] = useState<Toast | null>(null)
	const [open, setOpen] = useState(false)

	const show = useCallback((message: string, severity: Severity = 'info') => {
		setToast({ message, severity })
		setOpen(true)
	}, [])

	const api = useMemo<SnackbarApi>(
		() => ({
			show,
			showError: (err, fallback = 'Something went wrong') =>
				show(errorMessage(err, fallback), 'error'),
			showSuccess: (message) => show(message, 'success'),
		}),
		[show],
	)

	return (
		<SnackbarContext.Provider value={api}>
			{children}
			<Snackbar
				open={open}
				autoHideDuration={toast?.severity === 'error' ? 8000 : 4000}
				onClose={(_, reason) => {
					if (reason === 'clickaway') return
					setOpen(false)
				}}
				anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
			>
				<Alert
					onClose={() => setOpen(false)}
					severity={toast?.severity ?? 'info'}
					variant="filled"
					sx={{ maxWidth: 480 }}
				>
					{toast?.message}
				</Alert>
			</Snackbar>
		</SnackbarContext.Provider>
	)
}

export function useSnackbar(): SnackbarApi {
	const ctx = useContext(SnackbarContext)
	if (!ctx) throw new Error('useSnackbar must be used inside <SnackbarProvider>')
	return ctx
}
