/**
 * Single source of truth for the "🤖 Authored by Night Family member …"
 * footer we attach to anything the Member writes back to GitHub (PR bodies,
 * PR reviews, PR comments). Keeping the format in one place lets us evolve
 * the attribution without drift between channels.
 */

export interface AttributionInputs {
	memberName: string
	memberId: string
	taskId: string
	householdUrl: string
}

export function buildAttributionFooter(opts: AttributionInputs): string {
	const base = opts.householdUrl.replace(/\/$/, '')
	const memberUrl = `${base}/members/${encodeURIComponent(opts.memberId)}`
	const taskUrl = `${base}/tasks/${encodeURIComponent(opts.taskId)}`
	return `🤖 Authored by Night Family member [\`${opts.memberName}\`](${memberUrl}) · task [\`${opts.taskId.slice(0, 8)}\`](${taskUrl})`
}

/**
 * Prompt fragment that tells the agent to append `footer` to every comment
 * body it posts back to GitHub. The exact wording matters — the agent must
 * use the footer verbatim, including the leading `---` separator line, so
 * humans see the same attribution PR bodies have.
 */
export function buildAttributionInstruction(footer: string): string {
	return [
		`At the end of every comment body you post via \`gh pr review\` or`,
		`\`gh pr comment\`, append the following two lines verbatim, separated`,
		`from your comment text by a blank line. Do not paraphrase, translate,`,
		`or omit them — the Household relies on this attribution to link the`,
		`comment back to the Member and task:`,
		``,
		`---`,
		footer,
	].join('\n')
}
