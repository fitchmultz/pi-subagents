import { createHash, type Hash } from "node:crypto";
import * as fs from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { journalStamp, scanJournal, type JournalPolicy, type Projection } from "../../shared/journal-reader.ts";

function hashRange(fd: number, start: number, end: number, hash: Hash): void {
	const bytes = Buffer.allocUnsafe(64 * 1024);
	while (start < end) {
		const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, end - start), start);
		if (!count) throw new Error("Parent journal truncated during inspection");
		hash.update(bytes.subarray(0, count));
		start += count;
	}
}

const receiptProjection: Projection = (path) => {
	if (!path.length || ["type", "id", "timestamp", "customType"].includes(String(path[0]))) return true;
	if (path[0] === "details") return path.length === 1 || ["completion", "subagentCompletion", "result"].includes(String(path[1]))
		&& (path[1] !== "result" || path.length <= 3 || path[3] === "wait");
	if (path[0] === "message") return path.length === 1 || ["role", "toolName", "usage"].includes(String(path[1]))
		|| path[1] === "details" && (path.length === 2 || ["wait", "parentUsage"].includes(String(path[2])));
	return false;
};

/** Cache only LF-published receipt fields, never transcripts or accepted-but-unsaved messages. */
export function createParentReceiptReader(policy: JournalPolicy) {
	let cache: { file: string; identity: string; end: number; digest: string; records: Map<string, SessionEntry> } | undefined;
	return {
		clear() { cache = undefined; },
		read(file: string | undefined): ReadonlyMap<string, SessionEntry> {
			if (!file || !fs.existsSync(file)) { cache = undefined; return new Map(); }
			const fd = fs.openSync(file, "r");
			try {
				const stat = fs.fstatSync(fd, { bigint: true }), stamp = journalStamp(stat), identity = `${stat.dev}:${stat.ino}`;
				let hash = createHash("sha256");
				let append = cache?.file === file && cache.identity === identity && Number(stat.size) >= cache.end;
				if (append) {
					// Coarse timestamps can hide same-size edits; even a stat hit needs verified bytes.
					hashRange(fd, 0, cache!.end, hash);
					append = hash.copy().digest("hex") === cache!.digest;
				}
				if (!append) hash = createHash("sha256");
				const start = append ? cache!.end : 0, records = append ? new Map(cache!.records) : new Map<string, SessionEntry>();
				const end = scanJournal(fd, receiptProjection, ({ value }) => {
					if (value.type === "custom_message" || value.type === "message" && value.message?.role === "toolResult")
						records.set(value.id, value as SessionEntry);
				}, { policy, requireNewline: true, start, end: Number(stat.size) });
				hashRange(fd, start, end, hash);
				if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== stamp) throw new Error("Parent journal changed during inspection");
				cache = { file, identity, end, digest: hash.digest("hex"), records };
				return records;
			} finally { fs.closeSync(fd); }
		},
	};
}
