import { randomBytes } from 'node:crypto'
import type { Hono } from 'hono'
import type { AdminGuard } from '../auth/guard.ts'
import type { MemberRegistry } from '../members/registry.ts'
import type { RepoBindingStore } from './bindings.ts'

export interface RepoApiDeps {
	bindings: RepoBindingStore
	registry: MemberRegistry
	guard: AdminGuard
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

interface SuggestedRepo {
	repo: string
	members: { memberId: string; memberName: string; displayName: string }[]
}

export function mountRepoBindingsApi(app: Hono, deps: RepoApiDeps): void {
	app.get('/api/repos', (c) => {
		const guardResult = deps.guard.requireAuthenticated(c)
		if (guardResult) return guardResult
		const repos = deps.bindings.list()
		return c.json({ repos, suggested: collectSuggestions(deps.registry, repos) })
	})

	app.post('/api/repos/draft', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		if (!body || typeof body !== 'object') return c.json({ error: 'expected_object' }, 400)
		const repo = (body as Record<string, unknown>)['repo']
		if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
			return c.json({ error: 'invalid_repo' }, 400)
		}
		const webhookSecret = randomBytes(32).toString('hex')
		const url = new URL(c.req.url)
		const payloadUrl = `${url.protocol}//${url.host}/webhooks/github`
		const hooksSettingsUrl = `https://github.com/${repo}/settings/hooks/new`
		return c.json({
			repo,
			webhook_secret: webhookSecret,
			payload_url: payloadUrl,
			hooks_settings_url: hooksSettingsUrl,
		})
	})

	app.post('/api/repos', async (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult

		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json({ error: 'invalid_json' }, 400)
		}
		if (!body || typeof body !== 'object') return c.json({ error: 'expected_object' }, 400)
		const b = body as Record<string, unknown>

		const repo = b['repo']
		const webhookSecret = b['webhook_secret']
		if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
			return c.json({ error: 'invalid_repo' }, 400)
		}
		if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
			return c.json({ error: 'invalid_webhook_secret' }, 400)
		}

		const record = deps.bindings.upsert({ repo, webhookSecret })
		return c.json({ repo: record }, 200)
	})

	app.delete('/api/repos/:repo{.+}', (c) => {
		const guardResult = deps.guard.requireAdmin(c)
		if (guardResult) return guardResult
		const repo = decodeURIComponent(c.req.param('repo'))
		if (!REPO_RE.test(repo)) return c.json({ error: 'invalid_repo' }, 400)
		const ok = deps.bindings.delete(repo)
		if (!ok) return c.json({ error: 'not_found' }, 404)
		return c.json({ ok: true })
	})
}

/**
 * Build the "suggested" list: every repo any connected member's PAT can
 * reach, minus repos already bound. Members with `repos: null` (PAT is
 * unconstrained) contribute nothing — we'd have to enumerate the whole
 * GitHub account from the member side to know what's reachable, and the
 * member-side config already does that for `repos: string[]`. Suggestions
 * are sorted alphabetically; member attribution is preserved so the UI
 * can show who proposed each one.
 */
function collectSuggestions(registry: MemberRegistry, bound: { repo: string }[]): SuggestedRepo[] {
	const boundSet = new Set(bound.map((b) => b.repo))
	const byRepo = new Map<string, SuggestedRepo>()
	for (const m of registry.list()) {
		if (m.repos === null) continue
		for (const repo of m.repos) {
			if (boundSet.has(repo)) continue
			let entry = byRepo.get(repo)
			if (!entry) {
				entry = { repo, members: [] }
				byRepo.set(repo, entry)
			}
			if (!entry.members.some((x) => x.memberId === m.memberId)) {
				entry.members.push({
					memberId: m.memberId,
					memberName: m.memberName,
					displayName: m.displayName,
				})
			}
		}
	}
	return [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo))
}
