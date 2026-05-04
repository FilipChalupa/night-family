import { Alert, Button, Container, Stack, Typography } from '@mui/material'
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
	children: ReactNode
}

interface State {
	error: Error | null
}

/**
 * Top-level error boundary. The router has its own per-route boundary
 * (`<RouteError>` in router.tsx) for render errors *inside* a route, but
 * crashes in providers, the layout shell, or the router itself bypass that
 * and would otherwise leave the user on a blank page. This catches them.
 *
 * `componentDidCatch` is the only hook React still gives us for error
 * boundaries, so this remains a class component.
 */
export class AppErrorBoundary extends Component<Props, State> {
	state: State = { error: null }

	static getDerivedStateFromError(error: Error): State {
		return { error }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// Best-effort log so the stack lands somewhere even when the page is
		// frozen. Production tools can pick this up from the browser console.
		console.error('app-level boundary caught', error, info)
	}

	private reload = (): void => {
		window.location.reload()
	}

	render(): ReactNode {
		if (this.state.error === null) return this.props.children
		return (
			<Container maxWidth="sm" sx={{ py: 6 }}>
				<Stack spacing={2}>
					<Typography variant="h5" component="h1">
						Something went wrong
					</Typography>
					<Alert severity="error" variant="outlined">
						<Typography
							variant="body2"
							component="pre"
							sx={{
								fontFamily: 'monospace',
								whiteSpace: 'pre-wrap',
								wordBreak: 'break-word',
								m: 0,
							}}
						>
							{this.state.error.message || String(this.state.error)}
						</Typography>
					</Alert>
					<Typography variant="body2" color="text.secondary">
						The dashboard hit an unexpected error and stopped rendering. Reload to try
						again — if it keeps happening, check the browser console for details.
					</Typography>
					<Button
						variant="contained"
						onClick={this.reload}
						sx={{ alignSelf: 'flex-start' }}
					>
						Reload
					</Button>
				</Stack>
			</Container>
		)
	}
}
