import { describe, expect, it } from 'vitest'
import {
	isSensitiveFilename,
	redactBashOutput,
	redactFileContent,
	redactJson,
	redactString,
} from './redaction.ts'

describe('redactString', () => {
	it('redacts GitHub PAT (ghp_)', () => {
		const s = 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789'
		expect(redactString(s)).toBe('token: [REDACTED]')
	})

	it('redacts fine-grained GitHub PAT', () => {
		const s = 'token: github_pat_11ABCDEFG0123456789_abcdefghij'
		expect(redactString(s)).toBe('token: [REDACTED]')
	})

	it('redacts JWTs', () => {
		const jwt =
			'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
		expect(redactString(jwt)).toBe('[REDACTED]')
	})

	it('redacts PEM blocks', () => {
		const pem =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'
		expect(redactString(pem)).toBe('[REDACTED]')
	})

	it('redacts AWS access key id', () => {
		expect(redactString('aws: AKIAIOSFODNN7EXAMPLE')).toBe('aws: [REDACTED]')
	})

	it('leaves benign text alone', () => {
		const s = 'hello world, no secrets here'
		expect(redactString(s)).toBe(s)
	})
})

describe('isSensitiveFilename', () => {
	it.each([
		'.env',
		'.env.local',
		'config/.env.production',
		'my-secret-config.json',
		'credentials.json',
		'server.pem',
		'/abs/path/private.key',
	])('flags %s as sensitive', (name) => {
		expect(isSensitiveFilename(name)).toBe(true)
	})

	it.each(['package.json', 'src/index.ts', 'README.md'])('does not flag %s', (name) => {
		expect(isSensitiveFilename(name)).toBe(false)
	})
})

describe('redactFileContent', () => {
	it('strips env values for sensitive files', () => {
		const content = 'API_KEY=supersecret\nDB_URL=postgres://x\n# comment'
		const out = redactFileContent('.env', content)
		expect(out).toContain('API_KEY=[REDACTED]')
		expect(out).toContain('DB_URL=[REDACTED]')
		expect(out).toContain('# comment')
	})

	it('still applies token regex on non-sensitive files', () => {
		const content = 'leaked: ghp_abcdefghijklmnopqrstuvwxyz0123456789'
		expect(redactFileContent('src/foo.ts', content)).toContain('[REDACTED]')
	})
})

describe('redactBashOutput', () => {
	it('trims to maxLines and redacts', () => {
		const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`)
		const out = redactBashOutput(lines.join('\n'), 1000)
		expect(out.split('\n').length).toBe(1001) // 1000 + truncation marker
		expect(out).toContain('[…truncated 500 lines]')
	})

	it('redacts secrets in bash output', () => {
		const out = redactBashOutput('export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789')
		expect(out).toContain('[REDACTED]')
	})
})

describe('redactJson', () => {
	it('walks nested values', () => {
		const input = {
			a: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			b: { c: ['safe', 'github_pat_11ABCDEFG0123456789_abcdefghij'] },
		}
		const out = redactJson(input)
		expect(out.a).toBe('[REDACTED]')
		expect(out.b.c[0]).toBe('safe')
		expect(out.b.c[1]).toBe('[REDACTED]')
	})

	it('preserves non-string primitives', () => {
		const input = { n: 42, b: true, x: null }
		expect(redactJson(input)).toEqual(input)
	})
})
