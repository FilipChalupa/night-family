/** Shared display formatters. */

/** k/M-abbreviated token count; `null` → '' (for chart valueFormatters). */
export function formatTokens(value: number | null): string {
	if (value === null) return ''
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
	return value.toLocaleString()
}

/** Human-readable duration from seconds: `45s` / `3m 12s` / `1h 4m`. */
export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

/** Running totals of a numeric series (for cumulative charts). */
export function cumulative(values: number[]): number[] {
	let running = 0
	return values.map((v) => (running += v))
}
