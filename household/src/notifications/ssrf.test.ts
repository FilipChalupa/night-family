import { describe, expect, it } from 'vitest'
import { assertPublicUrl, isPublicIp, SsrfError } from './ssrf.ts'

describe('isPublicIp', () => {
	it('accepts routable public addresses', () => {
		for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.9', '2606:4700:4700::1111']) {
			expect(isPublicIp(ip)).toBe(true)
		}
	})

	it('rejects loopback / private / link-local / CGNAT / metadata (v4)', () => {
		for (const ip of [
			'127.0.0.1',
			'10.1.2.3',
			'172.16.5.5',
			'172.31.255.255',
			'192.168.0.1',
			'169.254.169.254', // cloud metadata
			'100.64.0.1', // CGNAT
			'0.0.0.0',
		]) {
			expect(isPublicIp(ip)).toBe(false)
		}
	})

	it('rejects loopback / ULA / link-local / mapped-v4 (v6)', () => {
		for (const ip of ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
			expect(isPublicIp(ip)).toBe(false)
		}
	})

	it('rejects unparseable input', () => {
		expect(isPublicIp('not-an-ip')).toBe(false)
	})
})

describe('assertPublicUrl', () => {
	it('resolves for a public literal IP over http/https', async () => {
		await expect(assertPublicUrl('https://8.8.8.8/hook')).resolves.toBeUndefined()
	})

	it('rejects a literal private/loopback/metadata IP', async () => {
		await expect(assertPublicUrl('http://127.0.0.1/x')).rejects.toBeInstanceOf(SsrfError)
		await expect(
			assertPublicUrl('http://169.254.169.254/latest/meta-data'),
		).rejects.toBeInstanceOf(SsrfError)
		await expect(assertPublicUrl('https://10.0.0.5/webhook')).rejects.toBeInstanceOf(SsrfError)
		await expect(assertPublicUrl('http://[::1]/x')).rejects.toBeInstanceOf(SsrfError)
	})

	it('rejects a hostname that resolves to loopback', async () => {
		await expect(assertPublicUrl('http://localhost/x')).rejects.toBeInstanceOf(SsrfError)
	})

	it('rejects non-http(s) schemes and malformed URLs', async () => {
		await expect(assertPublicUrl('ftp://8.8.8.8/x')).rejects.toBeInstanceOf(SsrfError)
		await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError)
		await expect(assertPublicUrl('not a url')).rejects.toBeInstanceOf(SsrfError)
	})
})
