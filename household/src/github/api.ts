import type { Hono } from 'hono'
import type { AdminGuard } from '../auth/guard.ts'
import type { RepoBindingStore } from './bindings.ts'

export interface RepoApiDeps {
	bindings: RepoBindingStore
	guard: AdminGuard
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function mountRepoBindingsApi(app: Hono, deps: RepoApiDeps): void {
	app.get('/api/repos', (c) => {
		const guardResult = deps.guard.requireAuthenticated(c)
		if (guardResult) return guardResult
		return c.json({ repos: deps.bindings.list() })
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
		const pat = b['pat']
		if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
			return c.json({ error: 'invalid_repo' }, 400)
		}
		if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
			return c.json({ error: 'invalid_webhook_secret' }, 400)
		}
		if (typeof pat !== 'string' || pat.length === 0) {
			return c.json({ error: 'pat_required' }, 400)
		}

		const record = deps.bindings.upsert({
			repo,
			webhookSecret,
			pat,
		})
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
