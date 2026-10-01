import * as fs from "node:fs";
import * as path from "node:path";
import { JsonProjection, readJsonProjection } from "../shared/journal-reader.ts";
import { HistoryIndexError } from "./types.ts";

const budget = 16 * 1024 * 1024;
export function readSavedOutput(file: string): string {
	const fd = fs.openSync(file, "r");
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.size > BigInt(budget)) throw new HistoryIndexError("RECORD_TOO_LARGE", "Selected saved output exceeds the 16 MiB detail budget.");
		const bytes = Buffer.alloc(Number(before.size));
		for (let offset = 0; offset < bytes.length;) {
			const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (!count) throw new HistoryIndexError("SOURCE_CHANGED", "Selected saved output was truncated.");
			offset += count;
		}
		const after = fs.fstatSync(fd, { bigint: true }), current = fs.statSync(file, { bigint: true });
		if (before.size !== after.size || before.ctimeNs !== after.ctimeNs || before.dev !== current.dev || before.ino !== current.ino) throw new HistoryIndexError("SOURCE_CHANGED", "Selected saved output changed; retry details.");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes);
	} finally { fs.closeSync(fd); }
}

/** Explicit legacy/compact owner detail: retain only this child's output, never transcript arrays. */
export function readCanonicalOutput(file: string, index: number): string | undefined {
	let prefix: Array<string | number>;
	if (path.basename(file) === "foreground.json") {
		const metadata = readJsonProjection(file, (keys) => !keys.length || keys[0] === "children" && (keys.length <= 2 || keys.length === 3 && keys[2] === "index"));
		const position = metadata.children?.findIndex((child: { index: number } | null) => child?.index === index);
		if (position === undefined || position < 0) return;
		prefix = ["children", position, "result"];
	} else prefix = path.basename(file) === "result.json" ? ["results", index] : ["result"];
	let length = 0;
	const projection = new JsonProjection((keys) => {
		if (prefix[0] === "children" && keys.length === 3 && keys[0] === "children" && keys[1] === prefix[1] && keys[2] === "index") return true;
		if (keys.length <= prefix.length) return keys.every((key, position) => key === prefix[position]);
		return keys.length === prefix.length + 1 && prefix.every((key, position) => key === keys[position]) && ["finalOutput", "output"].includes(String(keys.at(-1))) ? budget : false;
	}, (keys, text) => {
		if (keys.length === prefix.length + 1 && prefix.every((key, position) => key === keys[position]) && ["finalOutput", "output"].includes(String(keys.at(-1)))) {
			length += Buffer.byteLength(text);
			if (length > budget) throw new HistoryIndexError("RECORD_TOO_LARGE", "Selected canonical output exceeds the 16 MiB detail budget.");
		}
	});
	const fd = fs.openSync(file, "r"), decoder = new TextDecoder("utf8", { fatal: true });
	try {
		const before = fs.fstatSync(fd, { bigint: true }), bytes = Buffer.allocUnsafe(64 * 1024);
		for (let offset = 0; offset < Number(before.size);) {
			const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, Number(before.size) - offset), offset);
			if (!count) throw new HistoryIndexError("SOURCE_CHANGED", "Selected canonical output was truncated.");
			projection.write(decoder.decode(bytes.subarray(0, count), { stream: true })); offset += count;
		}
		projection.write(decoder.decode());
		const value = projection.finish(), after = fs.fstatSync(fd, { bigint: true }), current = fs.statSync(file, { bigint: true });
		if (prefix[0] === "children" && value?.children?.[prefix[1]]?.index !== index) throw new HistoryIndexError("SOURCE_CHANGED", "Selected canonical child changed; retry details.");
		if (before.size !== after.size || before.ctimeNs !== after.ctimeNs || before.dev !== current.dev || before.ino !== current.ino) throw new HistoryIndexError("SOURCE_CHANGED", "Selected canonical output changed; retry details.");
		let child: unknown = value;
		for (const key of prefix) child = child && typeof child === "object" ? (child as Record<string | number, unknown>)[key] : undefined;
		if (!child || typeof child !== "object") return;
		const result = child as Record<string, unknown>;
		return typeof result.finalOutput === "string" ? result.finalOutput : typeof result.output === "string" ? result.output : undefined;
	} finally { fs.closeSync(fd); }
}
