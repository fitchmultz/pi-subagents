import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const { loadRunsForAgent } = await import("../../src/runs/shared/run-history.ts");
const writerModule = new URL("../../src/runs/shared/run-history.ts", import.meta.url).href;

function fixture(t: { after: (fn: () => void) => void }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-history-")), previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	});
	return { root, file: path.join(root, "run-history.jsonl"), database: path.join(root, "history-index", "run-timing.sqlite") };
}

test("timing-history reads preserve other agents and an acknowledged concurrent write", (t) => {
	const f = fixture(t), entries = Array.from({ length: 1201 }, (_, index) => ({ agent: index < 201 ? "other" : "requested", task: `Timing sample ${index}`, ts: index, status: "ok", duration: index + 1 }));
	const original = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	fs.writeFileSync(f.file, original);
	const read = fs.readSync;
	let acknowledged = false;
	t.mock.method(fs, "readSync", function(fd, buffer, offset, length, position) {
		const snapshot = read.call(this, fd, buffer, offset, length, position);
		if (!acknowledged) {
			const writer = spawnSync(process.execPath, ["--input-type=module", "-e", `import { recordRun, loadRunsForAgent } from ${JSON.stringify(writerModule)}; recordRun("concurrent", "Acknowledged sample", 0, 7); if (loadRunsForAgent("concurrent")[0]?.task !== "Acknowledged sample") process.exit(1);`], { env: process.env, encoding: "utf8" });
			assert.equal(writer.status, 0, writer.stderr);
			acknowledged = true;
		}
		return snapshot;
	});
	syncBuiltinESMExports();
	let requested;
	try { requested = loadRunsForAgent("requested"); }
	finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.equal(acknowledged, true);
	assert.equal(requested.length, 1000);
	assert.equal(requested[0].task, "Timing sample 1200");
	assert.equal(loadRunsForAgent("concurrent")[0]?.task, "Acknowledged sample", "reading an older snapshot cannot erase a completed write");
	assert.equal(loadRunsForAgent("other").length, 201, "reading one agent cannot delete another agent's samples");
	assert.equal(fs.readFileSync(f.file, "utf8"), original, "the legacy journal is never replaced, rotated or appended");
});

test("timing history bounds legacy reads and retains the latest 1000 samples per agent under concurrent writers", async (t) => {
	const f = fixture(t), rows = Array.from({ length: 1500 }, (_, index) => JSON.stringify({ agent: index % 3 === 0 ? "other" : "requested", task: `Sample ${index}`, ts: index, status: "ok", duration: index + 1 }));
	const original = " ".repeat(2 * 1024 * 1024) + "\n" + rows.join("\n") + "\nnot-json\n";
	fs.writeFileSync(f.file, original);
	const read = fs.readSync; let bytesRead = 0;
	t.mock.method(fs, "readSync", function(fd, buffer, offset, length, position) {
		bytesRead += length;
		return read.call(this, fd, buffer, offset, length, position);
	});
	syncBuiltinESMExports();
	let samples;
	try { samples = loadRunsForAgent("requested"); }
	finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.ok(bytesRead <= 1024 * 1024, "the parent never reads the entire legacy journal");
	assert.equal(samples.length, 1000);
	assert.equal(samples[0].task, "Sample 1499");
	assert.equal(samples.at(-1)?.task, "Sample 1");
	assert.equal(fs.existsSync(f.database), false, "a reader cannot bootstrap or migrate storage");
	await Promise.all(["one", "two", "three", "four"].map((worker) => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", `import { recordRun, loadRunsForAgent } from ${JSON.stringify(writerModule)}; for (let i=0; i<25; i++) recordRun("requested", ${JSON.stringify(worker)}+i, 0, i); if (!loadRunsForAgent("requested").some(row => row.task === ${JSON.stringify(worker + "24")})) process.exit(1);`], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
		let error = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { error += chunk; });
		child.once("error", reject); child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(error || `Writer exited ${status}`)));
	})));
	const after = loadRunsForAgent("requested");
	assert.equal(after.length, 1000);
	for (const worker of ["one", "two", "three", "four"]) for (let index = 0; index < 25; index++) assert.ok(after.some((row) => row.task === `${worker}${index}`), "each completed concurrent sample survives");
	assert.equal(loadRunsForAgent("other").length, 500);
	const db = new DatabaseSync(f.database, { readOnly: true });
	try {
		assert.deepEqual(db.prepare("SELECT agent,COUNT(*) AS count FROM samples GROUP BY agent ORDER BY agent").all().map((row) => [row.agent, row.count]), [["other", 500], ["requested", 1000]], "retention bounds stored rows, not only the returned page");
		assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
	} finally { db.close(); }
	assert.equal(fs.statSync(path.dirname(f.database)).mode & 0o777, 0o700);
	assert.equal(fs.statSync(f.database).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(f.file, "utf8"), original);
});
