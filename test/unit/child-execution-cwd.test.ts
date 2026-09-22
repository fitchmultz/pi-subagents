import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { prepareChildExecutionCwd, requestChildExecutionCwd } from "../../src/runs/shared/child-execution-cwd.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cwd-intent-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const sessionFile = path.join(root, "session.jsonl");
	return { root, sessionFile, marker: `${sessionFile}.subagent-cwd-init` };
}

test("new-fork intent freezes once, while ordinary resumes never recreate a consumed intent", (t) => {
	const { root, sessionFile, marker } = fixture(t);
	requestChildExecutionCwd(sessionFile);
	assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), {});
	assert.throws(() => prepareChildExecutionCwd(sessionFile), /cwd was not supplied/);
	prepareChildExecutionCwd(sessionFile, root);
	prepareChildExecutionCwd(sessionFile, path.join(root, "different"));
	assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), { cwd: root });
	assert.equal(fs.existsSync(sessionFile), false, "intent preparation does not create or edit the journal");
	fs.unlinkSync(marker);
	prepareChildExecutionCwd(sessionFile, root);
	assert.equal(fs.existsSync(marker), false);
});

test("rejected launches undo only their request, preserving any previous pending initialization", (t) => {
	const { root, sessionFile, marker } = fixture(t);
	const undoNew = requestChildExecutionCwd(sessionFile, root);
	undoNew();
	assert.equal(fs.existsSync(marker), false);
	requestChildExecutionCwd(sessionFile);
	const undoReplacement = requestChildExecutionCwd(sessionFile, root);
	undoReplacement();
	assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), {});
});

test("explicit resume override is separate from the ordinary launch cwd; malformed intent fails before launch", (t) => {
	const { root, sessionFile, marker } = fixture(t);
	requestChildExecutionCwd(sessionFile, root);
	prepareChildExecutionCwd(sessionFile, path.join(root, "different"));
	assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), { cwd: root });
	assert.throws(() => requestChildExecutionCwd(sessionFile, "relative"), /must be absolute/);
	for (const data of ["null", "[]", '{"cwd":"relative"}', '{"cwd":4}', "truncated"]) {
		fs.writeFileSync(marker, data);
		assert.throws(() => prepareChildExecutionCwd(sessionFile, root));
		assert.equal(fs.readFileSync(marker, "utf8"), data, "failed preparation preserves its evidence");
	}
});
