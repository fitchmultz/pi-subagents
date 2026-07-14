import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (!parentSessionFile) return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
	return path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"));
}
