import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { findLatestSessionFile } from "../../src/shared/utils.ts";

describe("findLatestSessionFile", () => {
	it("returns the newest session and treats optional metadata failures as absent", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-sessions-"));
		try {
			const older = path.join(dir, "older.jsonl");
			const newer = path.join(dir, "newer.jsonl");
			fs.writeFileSync(older, "");
			fs.writeFileSync(newer, "");
			fs.utimesSync(older, 1, 1);
			fs.utimesSync(newer, 2, 2);
			assert.equal(findLatestSessionFile(dir), newer);
			assert.equal(findLatestSessionFile(path.join(dir, "missing")), null);

			fs.symlinkSync(path.join(dir, "missing-target"), path.join(dir, "broken.jsonl"));
			assert.equal(findLatestSessionFile(dir), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
