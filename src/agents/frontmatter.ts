export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");

	if (!/^---\s*$/.test(lines[0] ?? "")) return { frontmatter, body: normalized };
	const endIndex = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
	if (endIndex === -1) return { frontmatter, body: normalized };

	for (const line of lines.slice(1, endIndex)) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		frontmatter[match[1]] = value;
	}

	return { frontmatter, body: lines.slice(endIndex + 1).join("\n").trim() };
}
