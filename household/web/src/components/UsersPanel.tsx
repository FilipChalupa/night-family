import { useEffect, useState } from 'react'
import type { UserRecord, UserRole } from '../types.ts'

interface Props {
	canManage: boolean
	currentUsername: string | null
}

interface UsersResponse {
	primaryAdmin: string
	users: UserRecord[]
}

export function UsersPanel({ canManage, currentUsername }: Props) {
	const [data, setData] = useState<UsersResponse | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [showForm, setShowForm] = useState(false)

	const refresh = () => {
		setLoading(true)
		setError(null)
		void fetch('/api/users')
			.then(async (response) => {
				if (!response.ok) {
					const body = (await response.json().catch(() => ({}))) as { error?: string }
					throw new Error(body.error ?? `HTTP ${response.status}`)
				}
				return response.json() as Promise<UsersResponse>
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

	const updateRole = async (username: string, role: UserRole) => {
		const response = await fetch(`/api/users/${encodeURIComponent(username)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ role }),
		})
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string }
			throw new Error(body.error ?? `HTTP ${response.status}`)
		}
		refresh()
	}

	const remove = async (username: string) => {
		if (!confirm(`Remove ${username} from dashboard access?`)) return
		const response = await fetch(`/api/users/${encodeURIComponent(username)}`, {
			method: 'DELETE',
		})
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string }
			throw new Error(body.error ?? `HTTP ${response.status}`)
		}
		refresh()
	}

	if (loading) return <div className="empty">Loading users…</div>
	if (error) return <div className="empty">Error: {error}</div>
	if (!data) return <div className="empty">No users loaded.</div>

	return (
		<>
			{canManage ? (
				showForm ? (
					<UserForm
						onCreated={() => {
							setShowForm(false)
							refresh()
						}}
						onCancel={() => setShowForm(false)}
					/>
				) : (
					<div className="panel-actions">
						<button type="button" className="ghost" onClick={() => setShowForm(true)}>
							+ Add user
						</button>
					</div>
				)
			) : (
				<div className="note">
					You are signed in as readonly. User management is admin-only.
				</div>
			)}
			<table>
				<thead>
					<tr>
						<th>GitHub User</th>
						<th>Role</th>
						<th>Added</th>
						<th>Added By</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{data.users.map((user) => {
						const isPrimaryAdmin =
							user.username.toLowerCase() === data.primaryAdmin.toLowerCase()
						return (
							<tr key={user.username}>
								<td>
									<strong>{user.username}</strong>
									{currentUsername?.toLowerCase() ===
									user.username.toLowerCase() ? (
										<div className="dim" style={{ fontSize: 11 }}>
											you
										</div>
									) : null}
								</td>
								<td>
									{canManage ? (
										<select
											value={user.role}
											disabled={isPrimaryAdmin}
											onChange={(e) => {
												void updateRole(
													user.username,
													e.target.value as UserRole,
												)
											}}
										>
											<option value="admin">admin</option>
											<option value="readonly">readonly</option>
										</select>
									) : (
										<span className="dim">{user.role}</span>
									)}
								</td>
								<td className="dim" title={user.added_at}>
									{new Date(user.added_at).toLocaleDateString()}
								</td>
								<td className="dim">{user.added_by}</td>
								<td>
									{canManage && !isPrimaryAdmin ? (
										<button
											type="button"
											className="ghost"
											onClick={() => {
												void remove(user.username)
											}}
										>
											Remove
										</button>
									) : null}
								</td>
							</tr>
						)
					})}
				</tbody>
			</table>
		</>
	)
}

function UserForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
	const [username, setUsername] = useState('')
	const [role, setRole] = useState<UserRole>('readonly')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setSubmitting(true)
		try {
			const response = await fetch('/api/users', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username: username.trim(), role }),
			})
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { error?: string }
				throw new Error(body.error ?? `HTTP ${response.status}`)
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
				<div className="field">
					<label htmlFor="user-username">GitHub username</label>
					<input
						id="user-username"
						type="text"
						placeholder="octocat"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						required
					/>
				</div>
				<div className="field">
					<label htmlFor="user-role">Role</label>
					<select
						id="user-role"
						value={role}
						onChange={(e) => setRole(e.target.value as UserRole)}
					>
						<option value="readonly">readonly</option>
						<option value="admin">admin</option>
					</select>
				</div>
			</div>
			<div className="row end">
				{error ? <span className="error">{error}</span> : null}
				<button type="button" className="ghost" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" disabled={submitting || !username.trim()}>
					{submitting ? 'Saving…' : 'Add user'}
				</button>
			</div>
		</form>
	)
}
