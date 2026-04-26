/**
 * Redaction filter — Member runs this on event payloads before sending
 * to Household. Strips obvious secrets so they never leave the agent.
 *
 * Coverage (per plan §4):
 *  - AWS access keys
 *  - GitHub PATs (ghp_*, github_pat_*)
 *  - JWTs
 *  - PEM blocks
 *  - KEY=value lines in .env* / *secret* / *credential* / *.pem / *.key files
 *
 * Bash tool output: caller is responsible for trimming to 1000 lines first;
 * this module then runs the regex sweep on the trimmed output.
 */

const REDACTED = '[REDACTED]'

// AWS access key IDs (AKIA / ASIA + 16 chars) and secret access keys (40 chars).
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
const AWS_SECRET_ACCESS_KEY = /\b(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])\b/g

// GitHub tokens.
const GH_PAT = /\bghp_[A-Za-z0-9]{36,}\b/g
const GH_FINE_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g
const GH_OAUTH = /\bgho_[A-Za-z0-9]{36,}\b/g
const GH_USER_TOKEN = /\bghu_[A-Za-z0-9]{36,}\b/g
const GH_SERVER_TOKEN = /\bghs_[A-Za-z0-9]{36,}\b/g
const GH_REFRESH = /\bghr_[A-Za-z0-9]{36,}\b/g

// JWT — three base64url chunks separated by dots.
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

// PEM blocks (any kind: PRIVATE KEY, RSA PRIVATE KEY, CERTIFICATE, …).
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g

const SENSITIVE_FILENAME = /(^|[/\\])(\.env(\..*)?|.*secret.*|.*credential.*|.*\.pem|.*\.key)$/i

const KEY_VALUE_LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.+)$/gm

function maskTokens(input: string): string {
	return input
		.replace(PEM_BLOCK, REDACTED)
		.replace(GH_PAT, REDACTED)
		.replace(GH_FINE_PAT, REDACTED)
		.replace(GH_OAUTH, REDACTED)
		.replace(GH_USER_TOKEN, REDACTED)
		.replace(GH_SERVER_TOKEN, REDACTED)
		.replace(GH_REFRESH, REDACTED)
		.replace(JWT, REDACTED)
		.replace(AWS_ACCESS_KEY_ID, REDACTED)
		.replace(AWS_SECRET_ACCESS_KEY, (match) => {
			// Avoid stripping innocuous 40-char hex like SHA-1 digests.
			// Only redact when the candidate looks like base64 (has at least one
			// non-hex char from the AWS secret alphabet).
			return /[A-Z/+=]/.test(match) && /[a-z]/.test(match) ? REDACTED : match
		})
}

export function redactString(input: string): string {
	return maskTokens(input)
}

export function isSensitiveFilename(path: string): boolean {
	return SENSITIVE_FILENAME.test(path)
}

/**
 * Redact contents of a sensitive file (env-style KEY=value lines get stripped
 * to KEY=[REDACTED]; everything else still gets the regex sweep).
 */
export function redactFileContent(path: string, content: string): string {
	if (isSensitiveFilename(path)) {
		const stripped = content.replace(KEY_VALUE_LINE, (_match, key) => `${key}=${REDACTED}`)
		return maskTokens(stripped)
	}
	return maskTokens(content)
}

/**
 * Trim bash-style output to a maximum number of lines, then redact.
 */
export function redactBashOutput(output: string, maxLines = 1000): string {
	const lines = output.split('\n')
	const trimmed =
		lines.length <= maxLines
			? output
			: [...lines.slice(0, maxLines), `[…truncated ${lines.length - maxLines} lines]`].join(
					'\n',
				)
	return maskTokens(trimmed)
}

/**
 * Walk a JSON-serializable value, redact every string. Useful for event payloads.
 */
export function redactJson<T>(value: T): T {
	if (typeof value === 'string') {
		return redactString(value) as unknown as T
	}
	if (Array.isArray(value)) {
		return value.map((v) => redactJson(v)) as unknown as T
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = redactJson(v)
		}
		return out as unknown as T
	}
	return value
}
