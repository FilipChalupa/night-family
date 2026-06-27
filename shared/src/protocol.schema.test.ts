import { describe, expect, it } from 'vitest'
import { parseHouseholdToMember, parseMemberToHousehold } from './protocol.schema.ts'

describe('parseMemberToHousehold', () => {
	it('accepts a well-formed handshake', () => {
		const raw = JSON.stringify({
			type: 'handshake',
			protocol_version: '3.0.0',
			member_id: 'm1',
			member_name: 'memberone',
			display_name: 'Member One',
			skills: ['implement', 'review'],
			schedule: {
				timezone: 'UTC',
				nightWindows: [{ name: 'night', days: ['mon'], start: '22:00', end: '08:00' }],
			},
			provider: 'anthropic',
			model: 'claude-opus-4-7',
			worker_profile: 'medium',
		})
		const out = parseMemberToHousehold(raw)
		expect(out.ok).toBe(true)
		if (out.ok) expect(out.msg.type).toBe('handshake')
	})

	it('accepts a handshake carrying mcp_servers', () => {
		const raw = JSON.stringify({
			type: 'handshake',
			protocol_version: '3.4.0',
			member_id: 'm1',
			member_name: 'memberone',
			display_name: 'Member One',
			skills: ['implement'],
			schedule: {
				timezone: 'UTC',
				nightWindows: [{ name: 'night', days: ['mon'], start: '22:00', end: '08:00' }],
			},
			provider: 'anthropic',
			model: 'claude-opus-4-7',
			worker_profile: 'medium',
			mcp_servers: [
				{ name: 'linear', status: 'live', tool_count: 3 },
				{ name: 'slack', status: 'down', tool_count: 0 },
			],
		})
		const out = parseMemberToHousehold(raw)
		expect(out.ok).toBe(true)
		if (out.ok && out.msg.type === 'handshake') {
			expect(out.msg.mcp_servers).toEqual([
				{ name: 'linear', status: 'live', tool_count: 3 },
				{ name: 'slack', status: 'down', tool_count: 0 },
			])
		}
	})

	it('accepts a member.mcp status update', () => {
		const raw = JSON.stringify({
			type: 'member.mcp',
			servers: [{ name: 'linear', status: 'live', tool_count: 3 }],
		})
		const out = parseMemberToHousehold(raw)
		expect(out.ok).toBe(true)
		if (out.ok && out.msg.type === 'member.mcp') {
			expect(out.msg.servers[0]?.status).toBe('live')
		}
	})

	it('rejects a handshake without schedule', () => {
		const raw = JSON.stringify({
			type: 'handshake',
			protocol_version: '3.0.0',
			member_id: 'm1',
			member_name: 'memberone',
			display_name: 'Member One',
			skills: ['implement'],
			provider: 'anthropic',
			model: 'claude-opus-4-7',
			worker_profile: 'medium',
		})
		const out = parseMemberToHousehold(raw)
		expect(out.ok).toBe(false)
	})

	it('rejects invalid JSON', () => {
		const out = parseMemberToHousehold('{not json')
		expect(out.ok).toBe(false)
		if (!out.ok) expect(out.error).toMatch(/invalid_json/)
	})

	it('rejects unknown message type (graceful unknown handling)', () => {
		const raw = JSON.stringify({ type: 'mystery.future', foo: 1 })
		const out = parseMemberToHousehold(raw)
		expect(out.ok).toBe(false)
		if (!out.ok) expect(out.error).toMatch(/schema_invalid/)
	})

	it('rejects a known type missing required fields', () => {
		const raw = JSON.stringify({ type: 'task.completed' })
		const out = parseMemberToHousehold(raw)
		expect(out.ok).toBe(false)
		if (!out.ok) expect(out.error).toMatch(/schema_invalid/)
	})

	it('rejects a wrong-typed field', () => {
		const raw = JSON.stringify({
			type: 'heartbeat',
			status: 'idle',
			current_task: 42, // should be string | null
		})
		const out = parseMemberToHousehold(raw)
		expect(out.ok).toBe(false)
	})

	it('accepts heartbeat with optional current_task_title', () => {
		const raw = JSON.stringify({
			type: 'heartbeat',
			status: 'busy',
			current_task: 't1',
			current_task_title: 'doing the thing',
		})
		expect(parseMemberToHousehold(raw).ok).toBe(true)
	})
})

describe('parseHouseholdToMember', () => {
	it('accepts handshake.ack with protocol_version', () => {
		const raw = JSON.stringify({
			type: 'handshake.ack',
			household_name: 'home',
			session_id: 'sess-1',
			protocol_version: '2.0.0',
		})
		const out = parseHouseholdToMember(raw)
		expect(out.ok).toBe(true)
	})

	it('rejects handshake.ack missing protocol_version', () => {
		const raw = JSON.stringify({
			type: 'handshake.ack',
			household_name: 'home',
			session_id: 'sess-1',
		})
		expect(parseHouseholdToMember(raw).ok).toBe(false)
	})

	it('accepts ping', () => {
		expect(parseHouseholdToMember('{"type":"ping"}').ok).toBe(true)
	})

	it('accepts repos.refresh with reason (3.1.0)', () => {
		expect(parseHouseholdToMember('{"type":"repos.refresh","reason":"schedule_edge"}').ok).toBe(
			true,
		)
	})

	it('rejects repos.refresh missing reason', () => {
		expect(parseHouseholdToMember('{"type":"repos.refresh"}').ok).toBe(false)
	})
})

describe('parseMemberToHousehold: member.repos', () => {
	it('accepts member.repos with a list', () => {
		const out = parseMemberToHousehold(
			JSON.stringify({ type: 'member.repos', repos: ['o/a', 'o/b'] }),
		)
		expect(out.ok).toBe(true)
		if (out.ok && out.msg.type === 'member.repos') {
			expect(out.msg.repos).toEqual(['o/a', 'o/b'])
		}
	})

	it('accepts member.repos with empty array', () => {
		const out = parseMemberToHousehold(JSON.stringify({ type: 'member.repos', repos: [] }))
		expect(out.ok).toBe(true)
	})

	it('rejects member.repos missing repos field', () => {
		expect(parseMemberToHousehold('{"type":"member.repos"}').ok).toBe(false)
	})

	it('rejects member.repos with non-string entries', () => {
		const out = parseMemberToHousehold(
			JSON.stringify({ type: 'member.repos', repos: ['o/a', 42] }),
		)
		expect(out.ok).toBe(false)
	})

	it('accepts member.repos_error with reason and error', () => {
		const out = parseMemberToHousehold(
			JSON.stringify({
				type: 'member.repos_error',
				reason: 'periodic',
				error: 'rate_limited',
			}),
		)
		expect(out.ok).toBe(true)
	})

	it('rejects member.repos_error missing fields', () => {
		expect(parseMemberToHousehold('{"type":"member.repos_error"}').ok).toBe(false)
		expect(parseMemberToHousehold('{"type":"member.repos_error","reason":"x"}').ok).toBe(false)
	})
})
