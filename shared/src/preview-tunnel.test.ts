import { describe, expect, it } from 'vitest'
import {
	buildPreviewSubdomainUrl,
	decodeTunnel,
	encodeTunnel,
	parsePreviewHost,
} from './preview-tunnel.ts'

const DOMAIN = 'previews.night.example.com'

describe('parsePreviewHost', () => {
	it('parses a preview subdomain into task id + port', () => {
		expect(parsePreviewHost(`p3000-abc123.${DOMAIN}`, DOMAIN)).toEqual({
			taskId: 'abc123',
			port: 3000,
		})
	})

	it('keeps hyphens in a UUID task id (port is delimited by the first dash)', () => {
		const uuid = '0469f44b-f630-4abc-9def-0123456789ab'
		expect(parsePreviewHost(`p5173-${uuid}.${DOMAIN}`, DOMAIN)).toEqual({
			taskId: uuid,
			port: 5173,
		})
	})

	it('is case-insensitive and tolerates a :port suffix on the Host', () => {
		expect(parsePreviewHost(`P8080-Task.${DOMAIN.toUpperCase()}:443`, DOMAIN)).toEqual({
			taskId: 'task',
			port: 8080,
		})
	})

	it('rejects non-preview hosts and malformed labels', () => {
		expect(parsePreviewHost(`night.example.com`, DOMAIN)).toBeNull()
		expect(parsePreviewHost(`${DOMAIN}`, DOMAIN)).toBeNull() // bare domain, no label
		expect(parsePreviewHost(`web-abc.${DOMAIN}`, DOMAIN)).toBeNull() // no p<port> prefix
		expect(parsePreviewHost(`p0-abc.${DOMAIN}`, DOMAIN)).toBeNull() // port out of range
		expect(parsePreviewHost(`p70000-abc.${DOMAIN}`, DOMAIN)).toBeNull()
		expect(parsePreviewHost('', DOMAIN)).toBeNull()
	})
})

describe('buildPreviewSubdomainUrl', () => {
	it('round-trips with parsePreviewHost', () => {
		const url = buildPreviewSubdomainUrl(DOMAIN, 'task-9', 3000)
		expect(url).toBe(`https://p3000-task-9.${DOMAIN}`)
		const host = new URL(url).host
		expect(parsePreviewHost(host, DOMAIN)).toEqual({ taskId: 'task-9', port: 3000 })
	})
})

describe('encodeTunnel / decodeTunnel', () => {
	it('round-trips a frame and returns null on garbage', () => {
		const frame = {
			t: 'req.head',
			id: '1',
			method: 'GET',
			path: '/',
			headers: {},
			port: 3000,
		} as const
		expect(decodeTunnel(encodeTunnel(frame))).toEqual(frame)
		expect(decodeTunnel('not json{')).toBeNull()
	})

	it('round-trips a ws.open frame with subprotocols', () => {
		const frame = {
			t: 'ws.open' as const,
			id: 'w1',
			port: 5173,
			path: '/',
			headers: { origin: 'https://x' },
			protocols: ['vite-hmr'],
		}
		expect(decodeTunnel(encodeTunnel(frame))).toEqual(frame)
	})
})
