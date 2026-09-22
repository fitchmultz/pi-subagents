import { readFileSync } from "node:fs";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { Usage as NativeUsage } from "@earendil-works/pi-ai";
import type { Usage, UsageContribution } from "../../shared/types.ts";

function readEntries(file: string | undefined): FileEntry[] | undefined {
	if (!file) return;
	let text: string;
	try { text = readFileSync(file, "utf8"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const entries = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as FileEntry);
	return entries[0]?.type === "session" ? entries : undefined;
}

export function snapshotNativeUsage(file: string | undefined): Set<string> {
	return new Set(readEntries(file)?.map((entry) => entry.id));
}

export function addUsage(usage: Usage, value: NativeUsage, attribution?: Omit<UsageContribution, "usage">): void {
	usage.input += value.input ?? 0;
	usage.output += value.output ?? 0;
	usage.cacheRead += value.cacheRead ?? 0;
	usage.cacheWrite += value.cacheWrite ?? 0;
	usage.cost += value.cost?.total ?? 0;
	if (attribution) (usage.contributions ??= []).push({ ...attribution, usage: value });
}

/** Read native journals without opening a second writer or copying their transcripts. */
export function readNativeUsage(file: string | undefined, baseline: ReadonlySet<string>, boundaries: Array<string | undefined> = []): Usage[] | undefined {
	const entries = readEntries(file);
	if (!entries) return;
	const sessionId = entries[0]!.id;
	const totals: Usage[] = Array.from({ length: Math.max(1, boundaries.length) }, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contributions: [] }));
	let segment = 0;
	for (const entry of entries) {
		if (!baseline.has(entry.id) && !("checkpoint" in entry && entry.checkpoint === true)) {
			let native: NativeUsage | undefined;
			let provider: string | undefined;
			let model: string | undefined;
			if (entry.type === "usage") {
				native = entry.usage; provider = entry.provider; model = entry.model;
			} else if (entry.type === "compaction" || entry.type === "branch_summary") native = entry.usage;
			else if (entry.type === "message") {
				if (entry.message.role === "assistant") {
					native = entry.message.usage; provider = entry.message.provider; model = entry.message.responseModel ?? entry.message.model;
					totals[segment]!.turns++;
				} else if (entry.message.role === "toolResult") native = entry.message.usage;
			}
			if (native) addUsage(totals[segment]!, native, { id: `${sessionId}:${entry.id}`, provider, model });
		}
		if (entry.id === boundaries[segment] && segment < totals.length - 1) segment++;
	}
	return totals;
}
