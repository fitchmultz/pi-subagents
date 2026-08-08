import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";

it("writeAtomicJson creates private files", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-atomic-json-"));
	try {
		const file = path.join(dir, "status.json");
		writeAtomicJson(file, { ok: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { ok: true });
		if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
