export function formatRunIdAmbiguity(kind: string, prefix: string, candidates: string[]): string {
	const preview = candidates.slice(0, 5);
	return `Ambiguous ${kind} run id prefix '${prefix}' matched: ${preview.join(", ")}. ${candidates.length} matches (showing ${preview.length}). Provide a longer prefix or full run id.`;
}
