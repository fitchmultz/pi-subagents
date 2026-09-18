import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

test("same-cwd resumes omit the redundant fork-only flag without changing saved history", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-same-cwd-resume-"));
	const sessionFile = join(root, "saved.jsonl");
	const bytes = `${JSON.stringify({ type: "session", version: 3, id: "fixture", cwd: root })}\n`;
	writeFileSync(sessionFile, bytes);
	for (const cwd of [root, join(root, "replacement")]) {
		const { args } = buildPiArgs({ baseArgs: ["-p"], task: "resume", sessionEnabled: true, sessionFile, cwd,
			inheritProjectContext: false, inheritSkills: false });
		assert.equal(args.includes("--session-cwd"), cwd !== root,
			"only an actual cwd change needs the native override; ordinary upstream resumes must not receive an unknown flag");
		assert.equal(args[args.indexOf("--session") + 1], sessionFile);
		assert.equal(readFileSync(sessionFile, "utf8"), bytes);
	}
});
