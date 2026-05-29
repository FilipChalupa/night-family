/**
 * Runtime schemas for the GitHub webhook payloads our handlers consume.
 *
 * GitHub events carry far more than we read; these schemas validate only the
 * fields the handlers actually touch and let everything else pass through
 * (valibot's `object` strips unknown keys rather than rejecting them). The
 * point is twofold: replace the hand-rolled `body as { … }` casts in the
 * handlers with a validated, typed shape, and drop a malformed payload with a
 * log line instead of letting a wrong-typed field crash deep in a handler.
 *
 * Schemas stay deliberately lenient — fields the handlers treat defensively
 * (labels, comment author, PR merge state) are optional here too, so a webhook
 * that omits something harmless is processed, not silently dropped.
 */

import * as v from 'valibot'

const LabelSchema = v.object({ name: v.string() })

/** Issue object as it appears on `issues` and `issue_comment` payloads. */
const IssueSchema = v.object({
	number: v.number(),
	title: v.string(),
	body: v.nullish(v.string()),
	labels: v.optional(v.array(LabelSchema)),
	html_url: v.string(),
	state: v.optional(v.string()),
})

const CommentSchema = v.object({
	body: v.optional(v.string()),
	author_association: v.optional(v.string()),
	user: v.optional(v.object({ login: v.optional(v.string()) })),
})

const PullRequestSchema = v.object({
	number: v.number(),
	html_url: v.string(),
	state: v.optional(v.string()),
	merged: v.optional(v.boolean()),
	mergeable_state: v.optional(v.string()),
	behind_by: v.optional(v.number()),
	head: v.object({ ref: v.string(), sha: v.optional(v.string()) }),
	base: v.object({ ref: v.string() }),
})

const ReviewSchema = v.object({
	state: v.string(),
	body: v.optional(v.string()),
	author_association: v.optional(v.string()),
	user: v.optional(v.object({ login: v.optional(v.string()) })),
})

export const IssuesEventSchema = v.object({
	action: v.string(),
	issue: v.optional(IssueSchema),
	label: v.optional(v.object({ name: v.optional(v.string()) })),
})

export const IssueCommentEventSchema = v.object({
	action: v.string(),
	issue: v.optional(IssueSchema),
	comment: v.optional(CommentSchema),
})

export const PullRequestEventSchema = v.object({
	action: v.string(),
	pull_request: v.optional(PullRequestSchema),
})

export const PullRequestReviewEventSchema = v.object({
	action: v.string(),
	pull_request: v.optional(PullRequestSchema),
	review: v.optional(ReviewSchema),
})

export const PushEventSchema = v.object({
	ref: v.optional(v.string()),
	deleted: v.optional(v.boolean()),
})

export type IssuesEvent = v.InferOutput<typeof IssuesEventSchema>
export type IssueCommentEvent = v.InferOutput<typeof IssueCommentEventSchema>
export type PullRequestEvent = v.InferOutput<typeof PullRequestEventSchema>
export type PullRequestReviewEvent = v.InferOutput<typeof PullRequestReviewEventSchema>
export type PushEvent = v.InferOutput<typeof PushEventSchema>
export type PullRequest = v.InferOutput<typeof PullRequestSchema>

export type PayloadParse<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Validate an already-JSON-parsed webhook body against `schema`. Returns the
 * typed payload on success, or a short `path: message` description on failure
 * for the caller to log. Never throws.
 */
export function parsePayload<T>(
	schema: v.GenericSchema<unknown, T>,
	body: unknown,
): PayloadParse<T> {
	const result = v.safeParse(schema, body)
	if (!result.success) {
		const issue = result.issues[0]
		const path = issue?.path?.map((p) => p.key).join('.') ?? '<root>'
		return { ok: false, error: `${path}: ${issue?.message ?? 'invalid'}` }
	}
	return { ok: true, value: result.output }
}
