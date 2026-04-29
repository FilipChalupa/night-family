import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfirmDialogProvider } from './components/ConfirmDialog.tsx'
import { router } from './router.tsx'

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: 1,
			refetchOnWindowFocus: false,
			staleTime: 5_000,
		},
	},
})

const theme = createTheme({
	palette: {
		mode: 'dark',
		primary: { main: '#4a87ff' },
		background: { default: '#0c0d10', paper: '#15171c' },
	},
	typography: {
		fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
	},
	shape: { borderRadius: 8 },
})

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')

createRoot(root).render(
	<React.StrictMode>
		<QueryClientProvider client={queryClient}>
			<ThemeProvider theme={theme}>
				<CssBaseline enableColorScheme />
				<ConfirmDialogProvider>
					<RouterProvider router={router} />
				</ConfirmDialogProvider>
			</ThemeProvider>
		</QueryClientProvider>
	</React.StrictMode>,
)
