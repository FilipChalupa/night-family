/**
 * Single source of truth for the trailer attached to every PR body and
 * comment a Member writes back to GitHub. Two parts in one block:
 *
 *   - Visible footer line ("🤖 Authored by Night Family member …")
 *     that humans see on GitHub.
 *   - HTML marker (`<!-- night-family:member=… task=… -->`) the
 *     Household webhook handler greps for to recognize bot-authored
 *     content and skip the matching event (otherwise the Member's own
 *     comments would re-trigger triage cycles).
 *
 * Append `appendAttribution(...)` to anything posted to GitHub. PR bodies
 * are appended server-side in `tasks/workspace.ts`. Comments and reviews
 * go through the dedicated `post_issue_comment` / `post_pr_comment` /
 * `post_pr_review` tools, which call `appendAttribution` themselves —
 * the agent never has to remember it.
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

export function buildAttributionMarker(opts: { memberId: string; taskId: string }): string {
	return `<!-- night-family:member=${opts.memberId} task=${opts.taskId} -->`
}

/**
 * The full block the runner / tools attach: `---` separator, visible
 * footer, then the HTML marker. Returns `body` unchanged if it already
 * carries our marker for the same `member+task` pair (idempotent — safe
 * to call twice, e.g. on `pr edit` after `pr create`).
 */
export function appendAttribution(body: string, opts: AttributionInputs): string {
	const marker = buildAttributionMarker(opts)
	if (body.includes(marker)) return body
	const footer = buildAttributionFooter(opts)
	const trimmed = body.replace(/\s+$/, '')
	return `${trimmed}\n\n---\n${footer}\n${marker}\n`
}

const MARKER_RE = /<!--\s*night-family:member=([^\s>]+)\s+task=([^\s>]+)\s*-->/

/**
 * Parse a body for our HTML marker. Used by the Household webhook
 * handler to identify bot-authored comments. Returns the IDs if found,
 * or `null`.
 */
export function findAttributionMarker(body: string): { memberId: string; taskId: string } | null {
	const m = MARKER_RE.exec(body)
	if (!m) return null
	return { memberId: m[1]!, taskId: m[2]! }
}
