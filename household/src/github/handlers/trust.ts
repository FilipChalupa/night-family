/**
 * GitHub `author_association` gating for webhook triggers.
 *
 * The webhook handlers act on actor-driven events (issue comments, PR
 * reviews) that on a public repo can come from anyone with a GitHub
 * account. To avoid drive-by spam and prompt-injection from random
 * outsiders, only repo-affiliated authors are allowed to drive
 * automation; everyone else gets logged-and-ignored.
 *
 * Trust set deliberately excludes `CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR`:
 * having had a single PR merged historically isn't enough to grant
 * ongoing privilege to spawn LLM work.
 */

const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

export function isTrustedAuthorAssociation(value: unknown): boolean {
	return typeof value === 'string' && TRUSTED_ASSOCIATIONS.has(value)
}
