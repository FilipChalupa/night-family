import { useEffect, useState } from 'react'

interface RepoBinding {
	repo: string
	hasPat: boolean
	createdAt: string
	updatedAt: string
}

export function ReposPanel() {
	const [repos, setRepos] = useState<RepoBinding[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showForm, setShowForm] = useState(false)

	const refresh = () => {
		setLoading(true)
		void fetch('/api/repos')
			.then((r) => r.json())
			.then((j: { repos: RepoBinding[] }) => {
				setRepos(j.repos)
				setLoading(false)
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : String(err))
				setLoading(false)
			})
	}

	useEffect(refresh, [])

	const remove = async (repo: string) => {
		if (!confirm(`Remove repo binding for ${repo}?`)) return
		await fetch(`/api/repos/${encodeURIComponent(repo)}`, { method: 'DELETE' })
		refresh()
	}

	if (loading) return <div className="empty">Loading repos…</div>
	if (error) return <div className="empty">Error: {error}</div>

	return (
		<>
			{showForm ? (
				<RepoForm
					onCreated={() => {
						setShowForm(false)
						refresh()
					}}
					onCancel={() => setShowForm(false)}
				/>
			) : (
				<div style={{ marginBottom: 12 }}>
					<button type="button" className="ghost" onClick={() => setShowForm(true)}>
						+ Add repo binding
					</button>
				</div>
			)}

			{repos.length === 0 ? (
				<div className="empty">
					No repo bindings yet. Add one to enable issue import + PR tracking.
				</div>
			) : (
				<table>
					<thead>
						<tr>
							<th>Repo</th>
							<th>PAT</th>
							<th>Webhook URL</th>
							<th>Created</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{repos.map((r) => (
							<tr key={r.repo}>
								<td>
									<code>{r.repo}</code>
								</td>
								<td className={r.hasPat ? '' : 'dim'}>
									{r.hasPat ? '✓ stored' : 'missing'}
								</td>
								<td className="dim" style={{ fontSize: 11 }}>
									{`${window.location.origin}/webhooks/github`}
								</td>
								<td className="dim" title={r.createdAt}>
									{new Date(r.createdAt).toLocaleDateString()}
								</td>
								<td>
									<button
										type="button"
										className="ghost"
										onClick={() => {
											void remove(r.repo)
										}}
									>
										Remove
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</>
	)
}

function RepoForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
	const [repo, setRepo] = useState('')
	const [secret, setSecret] = useState('')
	const [pat, setPat] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			const res = await fetch('/api/repos', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					repo: repo.trim(),
					webhook_secret: secret,
					pat: pat.trim() || null,
				}),
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				throw new Error(body.error ?? `HTTP ${res.status}`)
			}
			onCreated()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<form className="task-form" onSubmit={submit}>
			<div className="row">
				<input
					type="text"
					placeholder="org/name"
					value={repo}
					onChange={(e) => setRepo(e.target.value)}
					required
					pattern="[^/]+/[^/]+"
				/>
				<input
					type="password"
					placeholder="webhook secret"
					value={secret}
					onChange={(e) => setSecret(e.target.value)}
					required
				/>
				<input
					type="password"
					placeholder="GitHub PAT (fine-grained)"
					value={pat}
					onChange={(e) => setPat(e.target.value)}
				/>
			</div>
			<div className="row end">
				{error ? <span className="error">{error}</span> : null}
				<button type="button" className="ghost" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" disabled={submitting}>
					{submitting ? 'Saving…' : 'Save'}
				</button>
			</div>
		</form>
	)
}
