import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

test("same-cwd resumes omit the redundant fork-only flag without changing saved history", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-same-cwd-resume-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "replacement"));
	symlinkSync(root, join(root, "alias"), "dir");
	const sessionFile = join(root, "saved.jsonl");
	const bytes = `${JSON.stringify({ type: "session", version: 3, id: "fixture", cwd: root })}\n`;
	writeFileSync(sessionFile, bytes);
	for (const cwd of [root, `${root}/`, join(root, "alias"), join(root, "replacement")]) {
		const { args, env } = buildPiArgs({ baseArgs: ["-p"], task: "resume", sessionEnabled: true, sessionFile, cwd,
			inheritProjectContext: false, inheritSkills: false });
		assert.equal(args.includes("--session-cwd"), false);
		assert.equal(Boolean(env.PI_SUBAGENT_SESSION_CWD), cwd === join(root, "replacement"));
		if (env.PI_SUBAGENT_SESSION_CWD) {
			assert.equal(JSON.parse(env.PI_SUBAGENT_SESSION_CWD).cwd, cwd);
			assert.match(env.NODE_OPTIONS!, /--import=.*session-cwd-preload/);
		} else assert.equal(env.NODE_OPTIONS, undefined);
		assert.equal(args[args.indexOf("--session") + 1], sessionFile);
		assert.equal(readFileSync(sessionFile, "utf8"), bytes);
	}
});

test("uncertain existing headers and unavailable original directories retain the native override", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-unknown-session-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const fixtures = ["", "not json\n", JSON.stringify({ type: "message", cwd: root }),
		JSON.stringify({ type: "session" }), JSON.stringify({ type: "session", cwd: "" }),
		JSON.stringify({ type: "session", cwd: join(root, "missing-original") })];
	const sessionFiles = fixtures.map((bytes, index) => {
		const file = join(root, `${index}.jsonl`);
		writeFileSync(file, bytes);
		return file;
	});
	const dangling = join(root, "dangling.jsonl");
	symlinkSync(join(root, "absent.jsonl"), dangling);
	for (const sessionFile of [...sessionFiles, root, dangling]) {
		const { args, env } = buildPiArgs({ baseArgs: [], task: "resume", sessionEnabled: true, sessionFile, cwd: root,
			inheritProjectContext: false, inheritSkills: false });
		assert.equal(args.includes("--session-cwd"), false);
		assert.equal(JSON.parse(env.PI_SUBAGENT_SESSION_CWD!).cwd, root);
	}
	fixtures.forEach((bytes, index) => assert.equal(readFileSync(sessionFiles[index], "utf8"), bytes));
});

test("header-only reads preserve split UTF-8, large headers, and EOF without a newline", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-header-read-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const read = fs.readSync;
	let bytesRead = 0;
	t.mock.method(fs, "readSync", function(...args) {
		const count = read.apply(this, args);
		bytesRead += count;
		return count;
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const cwd = join(root, "é");
	mkdirSync(cwd);
	const empty = { type: "session", padding: "", cwd };
	const prefixLength = Buffer.byteLength(JSON.stringify(empty).split("é")[0]);
	for (const [index, padding] of ["a".repeat(4095 - prefixLength), "a".repeat(128 * 1024)].entries()) {
		const header = JSON.stringify({ ...empty, padding });
		const sessionFile = join(root, `${index}.jsonl`);
		const bytes = index === 0 ? `${header}\n${"history\n".repeat(100_000)}` : header;
		writeFileSync(sessionFile, bytes);
		bytesRead = 0;
		const { args, env } = buildPiArgs({ baseArgs: [], task: "resume", sessionEnabled: true, sessionFile, cwd,
			inheritProjectContext: false, inheritSkills: false });
		assert.equal(args.includes("--session-cwd"), false);
		assert.equal(env.PI_SUBAGENT_SESSION_CWD, undefined, "decoded UTF-8/EOF header preserves the actual physical cwd");
		assert.ok(bytesRead >= Buffer.byteLength(header), "the native header was actually read");
		assert.ok(bytesRead <= Math.ceil((Buffer.byteLength(header) + 1) / 4096) * 4096, "reads stop within one chunk of the header, not the large transcript");
		assert.equal(readFileSync(sessionFile, "utf8"), bytes);
	}
});
