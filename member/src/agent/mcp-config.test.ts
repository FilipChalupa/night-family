import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	defaultMcpConfigYaml,
	expandEnvMap,
	expandEnvRefs,
	parseMcpConfig,
	resolveMcpConfig,
} from './mcp-config.ts'

describe('parseMcpConfig', () => {
	it('returns empty for blank / no mcpServers', () => {
		expect(parseMcpConfig('').servers).toEqual([])
		expect(parseMcpConfig('other: 1').servers).toEqual([])
	})

	it('infers stdio from command and http from url', () => {
		const cfg = parseMcpConfig(`
mcpServers:
  slack:
    command: npx
    args: ['-y', 'srv']
    env: { SLACK_BOT_TOKEN: '\${TOK}' }
    allow: [a, b]
  remote:
    url: https://example.com/mcp
`)
		const slack = cfg.servers.find((s) => s.name === 'slack')!
		const remote = cfg.servers.find((s) => s.name === 'remote')!
		expect(slack.transport).toBe('stdio')
		expect(slack.args).toEqual(['-y', 'srv'])
		expect(slack.env).toEqual({ SLACK_BOT_TOKEN: '${TOK}' })
		expect(slack.allow).toEqual(['a', 'b'])
		expect(remote.transport).toBe('http')
		expect(remote.url).toBe('https://example.com/mcp')
	})

	it('honors an explicit transport and disabled flag', () => {
		const cfg = parseMcpConfig(`
mcpServers:
  sse:
    transport: sse
    url: https://x/y
  off:
    command: foo
    disabled: true
`)
		expect(cfg.servers.find((s) => s.name === 'sse')!.transport).toBe('sse')
		expect(cfg.servers.find((s) => s.name === 'off')!.disabled).toBe(true)
	})

	it('distinguishes "all tools" (no allow) from "none" (empty allow)', () => {
		const cfg = parseMcpConfig(`
mcpServers:
  all: { command: a }
  none: { command: b, allow: [] }
`)
		expect(cfg.servers.find((s) => s.name === 'all')!.allow).toBeNull()
		expect(cfg.servers.find((s) => s.name === 'none')!.allow).toEqual([])
	})

	it('rejects a stdio server without a command and http without a url', () => {
		expect(() => parseMcpConfig('mcpServers:\n  x: { transport: stdio }')).toThrow(/command/)
		expect(() => parseMcpConfig('mcpServers:\n  x: { transport: http }')).toThrow(/url/)
	})

	it('rejects malformed fields', () => {
		expect(() => parseMcpConfig('mcpServers: [1,2]')).toThrow(/map of name/)
		expect(() => parseMcpConfig('mcpServers:\n  x: { command: a, allow: 5 }')).toThrow(/allow/)
		expect(() => parseMcpConfig('mcpServers:\n  x: { command: a, env: 5 }')).toThrow(/env/)
	})
})

describe('expandEnvRefs', () => {
	const env = { TOK: 'secret', TEAM: 'T123' }

	it('expands ${VAR} references', () => {
		expect(expandEnvRefs('Bearer ${TOK}', env)).toBe('Bearer secret')
		expect(expandEnvRefs('no refs here', env)).toBe('no refs here')
	})

	it('throws on an unset reference', () => {
		expect(() => expandEnvRefs('${MISSING}', env)).toThrow(/MISSING/)
	})

	it('expandEnvMap maps every value', () => {
		expect(expandEnvMap({ a: '${TOK}', b: '${TEAM}' }, env)).toEqual({ a: 'secret', b: 'T123' })
		expect(expandEnvMap(undefined, env)).toBeUndefined()
	})
})

describe('resolveMcpConfig', () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('parses an explicit MCP_CONFIG_FILE path', async () => {
		const path = join(dir, 'mcp.yaml')
		await writeFile(path, 'mcpServers:\n  s: { command: npx }')
		const { config, source } = resolveMcpConfig(path)
		expect(source).toBe(path)
		expect(config.servers).toHaveLength(1)
	})

	it('throws when the explicit path is missing', () => {
		expect(() => resolveMcpConfig(join(dir, 'nope.yaml'))).toThrow(/missing file/)
	})

	it('returns empty when no file and no env override', () => {
		// Pass empty string to skip the env var; the conventional paths won't
		// exist in the test sandbox, so it falls through to empty.
		const { config, source } = resolveMcpConfig('')
		expect(source).toBeNull()
		expect(config.servers).toEqual([])
	})
})

describe('template', () => {
	it('ships inert — the generated template has every example commented out', () => {
		expect(parseMcpConfig(defaultMcpConfigYaml()).servers).toEqual([])
	})

	it('its example blocks are valid once uncommented', () => {
		// Uncomment only the indented example lines — leave the top-level header
		// comments and the "# ---" section headers as comments — to prove the
		// snippets are well-formed YAML.
		const uncommented = defaultMcpConfigYaml()
			.split('\n')
			.map((l) => {
				if (/^\s+# ---/.test(l)) return l
				if (/^\s+#/.test(l)) return l.replace(/^(\s+)# ?/, '$1')
				return l
			})
			.join('\n')
		const cfg = parseMcpConfig(uncommented)
		const names = cfg.servers.map((s) => s.name).sort()
		expect(names).toEqual(['example-remote', 'example-stdio'])
		expect(cfg.servers.find((s) => s.name === 'example-stdio')!.transport).toBe('stdio')
		expect(cfg.servers.find((s) => s.name === 'example-remote')!.transport).toBe('http')
	})
})
