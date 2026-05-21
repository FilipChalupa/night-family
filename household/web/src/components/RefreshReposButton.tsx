import { Button, Chip, Stack, Tooltip, Typography } from '@mui/material'
import { useState } from 'react'
import type { MemberSnapshot } from '../types.ts'

export function RefreshReposButton({
	memberId,
	disabled,
	lastError,
}: {
	memberId: string
	disabled: boolean
	lastError: MemberSnapshot['lastReposError']
}) {
	const [pending, setPending] = useState(false)
	const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null)
	const click = async () => {
		setPending(true)
		setFeedback(null)
		try {
			const r = await fetch(`/api/members/${encodeURIComponent(memberId)}/refresh-repos`, {
				method: 'POST',
			})
			const json = (await r.json().catch(() => ({}))) as Record<string, unknown>
			if (!r.ok) {
				const reason = typeof json.error === 'string' ? json.error : `HTTP ${r.status}`
				setFeedback({ ok: false, message: reason })
				return
			}
			const sessions = typeof json.sessions === 'number' ? json.sessions : 1
			setFeedback({
				ok: true,
				message: `Asked ${sessions} session${sessions === 1 ? '' : 's'} to refresh.`,
			})
		} catch (err) {
			setFeedback({ ok: false, message: err instanceof Error ? err.message : String(err) })
		} finally {
			setPending(false)
		}
	}
	return (
		<Stack spacing={0.5} sx={{ alignItems: 'flex-end' }}>
			<Tooltip title="Re-fetch this member's accessible-repos list from GitHub. Useful right after adding the member as a collaborator on a new repo.">
				<span>
					<Button
						size="small"
						variant="outlined"
						onClick={() => void click()}
						disabled={disabled || pending}
					>
						{pending ? 'Refreshing…' : 'Refresh repos'}
					</Button>
				</span>
			</Tooltip>
			{feedback ? (
				<Typography
					variant="caption"
					color={feedback.ok ? 'success.main' : 'error'}
					sx={{ maxWidth: 240, textAlign: 'right' }}
				>
					{feedback.message}
				</Typography>
			) : null}
			{lastError ? <LastReposErrorChip error={lastError} /> : null}
		</Stack>
	)
}

function LastReposErrorChip({ error }: { error: NonNullable<MemberSnapshot['lastReposError']> }) {
	const tooltip = `Last repos refresh (${error.reason}) failed at ${error.at}: ${error.error}. The previous list is still in use; click Refresh repos to try again.`
	return (
		<Tooltip title={tooltip}>
			<Chip
				label={`Last refresh failed · ${error.reason}`}
				size="small"
				color="error"
				variant="outlined"
				sx={{ maxWidth: 240 }}
			/>
		</Tooltip>
	)
}
