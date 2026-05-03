export function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	if (ms < 0) return 'in the future'
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
	// Above 30h, hours stop being readable — switch to days.
	if (ms < 108_000_000) return `${Math.floor(ms / 3_600_000)}h ago`
	return `${Math.floor(ms / 86_400_000)}d ago`
}
