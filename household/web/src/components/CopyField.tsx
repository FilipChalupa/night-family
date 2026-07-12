import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { IconButton, TextField, Tooltip } from '@mui/material'
import { useState } from 'react'

/**
 * Read-only value with a one-click copy button and "Copied" feedback. Shared by
 * the repo-webhook-secret reveal and the one-time join-token reveal.
 */
export function CopyField({
	label,
	value,
	multiline = false,
}: {
	label: string
	value: string
	multiline?: boolean
}) {
	const [copied, setCopied] = useState(false)
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			// clipboard blocked (insecure context / permissions) — leave the value
			// selectable so the user can copy manually.
		}
	}
	return (
		<TextField
			label={label}
			value={value}
			size="small"
			fullWidth
			multiline={multiline}
			slotProps={{
				input: {
					readOnly: true,
					endAdornment: (
						<Tooltip title={copied ? 'Copied' : 'Copy'}>
							<IconButton
								size="small"
								onClick={() => void copy()}
								aria-label={`Copy ${label.toLowerCase()}`}
							>
								<ContentCopyIcon fontSize="small" />
							</IconButton>
						</Tooltip>
					),
				},
			}}
		/>
	)
}
