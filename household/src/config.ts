/**
 * Household env-driven config. Loaded once at process start.
 */

export interface HouseholdConfig {
	householdName: string
	primaryAdminGithubUsername: string | null
	requireUiLogin: boolean
	port: number
	dataDir: string
	configDir: string
	githubOauth: {
		clientId: string
		clientSecret: string
	} | null
	secretsKey: string | null
	/**
	 * Base domain for preview subdomains (`PREVIEWS_DOMAIN`, e.g.
	 * `previews.night.example.com`). When set, the Household serves preview
	 * traffic for `p<port>-<task>.<domain>` Hosts by tunnelling to the owning
	 * Member over `/ws/preview`. `null` disables preview proxying.
	 */
	previewsDomain: string | null
	logLevel: string
	/**
	 * How many parallel review jobs the dispatcher creates per `implement`
	 * task entering `in-review`. Set to 1 for solo-PAT setups where you
	 * only have one daytime reviewer Member; 2+ for fleets.
	 */
	maxReviewJobsPerTask: number
	/**
	 * How long (ms) a pending review job waits for a different-login
	 * reviewer to free up before falling back to a same-login (self)
	 * reviewer. 0 disables the fallback (queue stays pending forever).
	 */
	selfReviewFallbackMs: number
}

function required(name: string): string {
	const v = process.env[name]
	if (!v) {
		throw new Error(`Missing required env var: ${name}`)
	}
	return v
}

function optional(name: string, fallback: string): string {
	return process.env[name] ?? fallback
}

function optionalNullable(name: string): string | null {
	const value = process.env[name]
	return value && value.length > 0 ? value : null
}

function optionalPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name]
	if (!raw || raw.length === 0) return fallback
	const n = Number.parseInt(raw, 10)
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(`Invalid env var ${name}: expected a non-negative integer, got "${raw}"`)
	}
	return n
}

function parseBoolean(name: string): boolean {
	const raw = required(name).trim().toLowerCase()
	if (raw === 'true') return true
	if (raw === 'false') return false
	throw new Error(`Invalid boolean env var ${name}: expected true or false`)
}

export function loadConfig(): HouseholdConfig {
	const requireUiLogin = parseBoolean('REQUIRE_UI_LOGIN')
	const clientId = optionalNullable('GITHUB_OAUTH_CLIENT_ID')
	const clientSecret = optionalNullable('GITHUB_OAUTH_CLIENT_SECRET')
	const primaryAdminGithubUsername = optionalNullable('PRIMARY_ADMIN_GITHUB_USERNAME')

	if (requireUiLogin) {
		if (!primaryAdminGithubUsername) {
			throw new Error('Missing required env var: PRIMARY_ADMIN_GITHUB_USERNAME')
		}
		if (!clientId) {
			throw new Error('Missing required env var: GITHUB_OAUTH_CLIENT_ID')
		}
		if (!clientSecret) {
			throw new Error('Missing required env var: GITHUB_OAUTH_CLIENT_SECRET')
		}
	}

	const githubOauth = clientId && clientSecret ? { clientId, clientSecret } : null

	return {
		householdName: optional('HOUSEHOLD_NAME', 'Somnambulator'),
		primaryAdminGithubUsername,
		requireUiLogin,
		port: Number.parseInt(optional('PORT', '8080'), 10),
		dataDir: optional('DATA_DIR', '/data'),
		configDir: optional('CONFIG_DIR', '/config'),
		githubOauth,
		secretsKey: process.env['SECRETS_KEY'] ?? null,
		previewsDomain: process.env['PREVIEWS_DOMAIN']?.trim() || null,
		logLevel: optional('LOG_LEVEL', 'info'),
		maxReviewJobsPerTask: optionalPositiveInt('MAX_REVIEW_JOBS_PER_TASK', 2),
		selfReviewFallbackMs: optionalPositiveInt('SELF_REVIEW_FALLBACK_MS', 10 * 60_000),
	}
}
