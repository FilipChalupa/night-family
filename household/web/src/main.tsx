import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'

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
		<ThemeProvider theme={theme}>
			<CssBaseline enableColorScheme />
			<App />
		</ThemeProvider>
	</React.StrictMode>,
)
