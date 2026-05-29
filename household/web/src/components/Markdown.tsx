import { Box, Link as MuiLink } from '@mui/material'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Render untrusted markdown (GitHub issue / PR bodies) safely.
 *
 * react-markdown does not emit raw HTML: without `rehype-raw`, any embedded
 * `<script>` / `<img onerror>` is shown as literal text rather than executed,
 * and its built-in URL transform strips dangerous protocols like `javascript:`
 * from links and images. So this needs no `dangerouslySetInnerHTML` and no
 * separate sanitiser — the safety comes from what we deliberately leave out.
 */
const components: Components = {
	a: ({ children, href }) => (
		<MuiLink href={href} target="_blank" rel="noopener noreferrer nofollow" underline="hover">
			{children}
		</MuiLink>
	),
}

export function Markdown({ children }: { children: string }) {
	return (
		<Box
			sx={{
				fontSize: '0.875rem',
				lineHeight: 1.6,
				wordBreak: 'break-word',
				'& p': { my: 0.75 },
				'& p:first-of-type': { mt: 0 },
				'& p:last-child': { mb: 0 },
				'& ul, & ol': { my: 0.75, pl: 3 },
				'& li': { mb: 0.25 },
				'& h1, & h2, & h3, & h4, & h5, & h6': {
					mt: 1.5,
					mb: 0.5,
					fontWeight: 600,
					lineHeight: 1.3,
				},
				'& h1': { fontSize: '1.3rem' },
				'& h2': { fontSize: '1.15rem' },
				'& h3': { fontSize: '1.05rem' },
				'& h4, & h5, & h6': { fontSize: '1rem' },
				'& code': {
					fontFamily: 'monospace',
					fontSize: '0.82em',
					px: 0.5,
					py: 0.1,
					borderRadius: 0.5,
					backgroundColor: 'action.hover',
				},
				'& pre': {
					my: 0.75,
					p: 1.5,
					overflowX: 'auto',
					backgroundColor: 'background.default',
					border: 1,
					borderColor: 'divider',
					borderRadius: 1,
				},
				'& pre code': { p: 0, backgroundColor: 'transparent', fontSize: '0.78rem' },
				'& blockquote': {
					my: 0.75,
					ml: 0,
					pl: 1.5,
					borderLeft: 3,
					borderColor: 'divider',
					color: 'text.secondary',
				},
				'& table': { borderCollapse: 'collapse', my: 0.75 },
				'& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5 },
				'& img': { maxWidth: '100%' },
				'& hr': { border: 0, borderTop: 1, borderColor: 'divider', my: 1.5 },
			}}
		>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{children}
			</ReactMarkdown>
		</Box>
	)
}
