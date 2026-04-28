import {
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogContentText,
	DialogTitle,
} from '@mui/material'
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react'

interface ConfirmOptions {
	title: string
	description?: ReactNode
	confirmLabel?: string
	cancelLabel?: string
	confirmColor?: 'primary' | 'error' | 'warning' | 'success' | 'info' | 'inherit'
}

type Confirm = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<Confirm | null>(null)

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<ConfirmOptions | null>(null)
	const resolverRef = useRef<((value: boolean) => void) | null>(null)

	const confirm = useCallback<Confirm>((opts) => {
		return new Promise<boolean>((resolve) => {
			resolverRef.current = resolve
			setState(opts)
		})
	}, [])

	const close = (result: boolean) => {
		resolverRef.current?.(result)
		resolverRef.current = null
		setState(null)
	}

	const value = useMemo(() => confirm, [confirm])

	return (
		<ConfirmContext.Provider value={value}>
			{children}
			<Dialog open={state !== null} onClose={() => close(false)} maxWidth="xs" fullWidth>
				<DialogTitle>{state?.title}</DialogTitle>
				{state?.description ? (
					<DialogContent>
						<DialogContentText component="div">{state.description}</DialogContentText>
					</DialogContent>
				) : null}
				<DialogActions>
					<Button onClick={() => close(false)}>{state?.cancelLabel ?? 'Cancel'}</Button>
					<Button
						onClick={() => close(true)}
						variant="contained"
						color={state?.confirmColor ?? 'primary'}
						autoFocus
					>
						{state?.confirmLabel ?? 'Confirm'}
					</Button>
				</DialogActions>
			</Dialog>
		</ConfirmContext.Provider>
	)
}

export function useConfirm(): Confirm {
	const ctx = useContext(ConfirmContext)
	if (!ctx) throw new Error('useConfirm must be used inside <ConfirmDialogProvider>')
	return ctx
}
