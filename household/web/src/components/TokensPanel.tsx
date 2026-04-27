import { useEffect, useState } from 'react'

interface TokenRecord {
	id: string
	name: string
	created_at: string
	created_by: string
	revoked_at: string | null
	revoked_by: string | null
	usage_count: number
}

interface TokensResponse {
	tokens: TokenRecord[]
}

interface Props {
	canManage: boolean
}

export function TokensPanel({ canManage }: Props) {
	const [data, setData] = useState<TokensResponse | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showForm, setShowForm] = useState(false)
	const [newToken, setNewToken] = useState<string | null>(null)

	const refresh = () => {
		setLoading(true)
		setError(null)
		void fetch('/api/tokens')
			.then(async (r) => {
				if (!r.ok) {
					const b = (await r.json().catch(() => ({}))) as { error?: string }
					throw new Error(b.error ?? `HTTP ${r.status}`)
				}
				return r.json() as Promise<TokensResponse>
			})
			.then((body) => {
				setData(body)
				setLoading(false)
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : String(err))
				setLoading(false)
			})
	}

	useEffect(refresh, [])

	const revoke = async (id: string, name: string) => {
		if (!confirm(`Revoke token "${name}"? All members using it will be disconnected.`)) return
		const r = await fetch(`/api/tokens/${id}`, { method: 'DELETE' })
		if (!r.ok) {
			const b = (await r.json().catch(() => ({}))) as { error?: string }
			alert(b.error ?? `HTTP ${r.status}`)
			return
		}
		refresh()
	}

	if (loading) return <div className="empty">Loading tokens…</div>
	if (error) return <div className="empty">Error: {error}</div>
	if (!data) return <div className="empty">No data.</div>

	const active = data.tokens.filter((t) => !t.revoked_at)
	const revoked = data.tokens.filter((t) => t.revoked_at)

	return (
		<>
			{newToken ? (
				<div className="token-reveal">
					<strong>New token generated — copy it now, it will not be shown again:</strong>
					<pre className="token-value">{newToken}</pre>
					<button
						type="button"
						className="ghost"
						onClick={() => {
							setNewToken(null)
							refresh()
						}}
					>
						Done
					</button>
				</div>
			) : null}

			{canManage ? (
				showForm ? (
					<TokenForm
						onCreated={(raw) => {
							setShowForm(false)
							setNewToken(raw)
						}}
						onCancel={() => setShowForm(false)}
					/>
				) : (
					<div className="panel-actions">
						<button type="button" className="ghost" onClick={() => setShowForm(true)}>
							+ Generate token
						</button>
					</div>
				)
			) : null}

			{active.length > 0 ? (
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th>Created</th>
							<th>Created by</th>
							<th>Members connected</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{active.map((t) => (
							<tr key={t.id}>
								<td>
									<strong>{t.name}</strong>
									<div className="dim" style={{ fontSize: 11 }}>
										id: {t.id}
									</div>
								</td>
								<td className="dim" title={t.created_at}>
									{new Date(t.created_at).toLocaleDateString()}
								</td>
								<td className="dim">{t.created_by}</td>
								<td className="dim">{t.usage_count}</td>
								<td>
									{canManage ? (
										<button
											type="button"
											className="ghost"
											onClick={() => void revoke(t.id, t.name)}
										>
											Revoke
										</button>
									) : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<div className="empty">No active tokens. Generate one to connect Members.</div>
			)}

			{revoked.length > 0 ? (
				<>
					<h3 style={{ marginTop: '1rem', fontSize: '0.85rem', opacity: 0.6 }}>
						Revoked tokens
					</h3>
					<table>
						<thead>
							<tr>
								<th>Name</th>
								<th>Revoked</th>
								<th>Revoked by</th>
							</tr>
						</thead>
						<tbody>
							{revoked.map((t) => (
								<tr key={t.id} style={{ opacity: 0.5 }}>
									<td>{t.name}</td>
									<td className="dim">
										{t.revoked_at
											? new Date(t.revoked_at).toLocaleDateString()
											: '—'}
									</td>
									<td className="dim">{t.revoked_by ?? '—'}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			) : null}
		</>
	)
}

function TokenForm({
	onCreated,
	onCancel,
}: {
	onCreated: (raw: string) => void
	onCancel: () => void
}) {
	const [name, setName] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			const r = await fetch('/api/tokens', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: name.trim() }),
			})
			if (!r.ok) {
				const b = (await r.json().catch(() => ({}))) as { error?: string }
				throw new Error(b.error ?? `HTTP ${r.status}`)
			}
			const body = (await r.json()) as { token: string }
			onCreated(body.token)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<form className="task-form" onSubmit={submit}>
			<div className="row">
				<div className="field">
					<label htmlFor="token-name">Token name</label>
					<input
						id="token-name"
						type="text"
						placeholder="e.g. laptop-fleet"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
					/>
				</div>
			</div>
			<div className="row end">
				{error ? <span className="error">{error}</span> : null}
				<button type="button" className="ghost" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" disabled={submitting || !name.trim()}>
					{submitting ? 'Generating…' : 'Generate'}
				</button>
			</div>
		</form>
	)
}
