import { describe, expect, it } from 'vitest'
import { parseHouseholdToMember, parseMemberToHousehold } from './protocol.schema.ts'

describe('parseMemberToHousehold', () => {
	it('accepts a well-formed handshake', () => {
		const raw = JSON.stringify({
			type: 'handshake',
			protocol_version: '1.0.0',
			member_id: 'm1',
			member_name: 'Member One',
			skills: ['implement', 'review'],
			provider: 'anthropic',
			model: 'claude-opus-4-7',
			worker_profile: 'medium',
		})
		const out = parseMemberToHousehold(raw)
		expect(out.ok).toBe(true)
		if (out.ok) expect(out.msg.type).toBe('handshake')
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
			protocol_version: '1.0.0',
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
})
