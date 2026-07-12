import * as fs from "node:fs";
import type { TokenUsage } from "./types.ts";
import { findLatestSessionFile } from "./utils.ts";

export function parseSessionTokens(sessionDir: string): TokenUsage | null {
	const sessionFile = findLatestSessionFile(sessionDir);
	if (!sessionFile) return null;
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		let input = 0;
		let output = 0;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				const usage = entry.usage ?? entry.message?.usage;
				if (usage) {
					input += usage.inputTokens ?? usage.input ?? 0;
					output += usage.outputTokens ?? usage.output ?? 0;
				}
			} catch {
				// Ignore malformed lines while scanning usage entries.
			}
		}
		return { input, output, total: input + output };
	} catch {
		// Usage extraction should not fail the run.
		return null;
	}
}
