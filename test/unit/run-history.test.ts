import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const { recordRun, loadRunsForAgent } = await import("../../src/runs/shared/run-history.ts");
const writerModule = new URL("../../src/runs/shared/run-history.ts", import.meta.url).href;

test("hot timing admission retains a sample while an attached WAL writer finishes", async (t) => {
	const f = fixture(t), ready = path.join(f.root, "ready"), release = path.join(f.root, "release"), closed = path.join(f.root, "closed");
	recordRun("hot", "Migration complete", 0, 0);
	assert.equal(loadRunsForAgent("hot")[0]?.task, "Migration complete");
	const writer = spawn(process.execPath, ["--input-type=module", "-e", `
		import fs from "node:fs"; import { DatabaseSync } from "node:sqlite";
		const db = new DatabaseSync(${JSON.stringify(f.database)});
		db.exec("BEGIN IMMEDIATE");
		fs.writeFileSync(${JSON.stringify(ready)}, "write transaction held");
		setTimeout(() => { db.close(); process.exit(1); }, 5000).unref();
		const timer = setInterval(() => {
			if (!fs.existsSync(${JSON.stringify(release)})) return;
			clearInterval(timer);
			setTimeout(() => { db.exec("COMMIT"); db.close(); fs.writeFileSync(${JSON.stringify(closed)}, "writer closed"); }, 450);
		}, 1);
	`], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
	let error = ""; writer.stderr.setEncoding("utf8"); writer.stderr.on("data", (chunk) => { error += chunk; });
	const exited = new Promise<void>((resolve, reject) => {
		writer.once("error", reject); writer.once("exit", (status) => status === 0 ? resolve() : reject(new Error(error || `Writer exited ${status}`)));
	});
	try {
		const deadline = Date.now() + 5000;
		while (!fs.existsSync(ready)) { assert.ok(Date.now() < deadline, "native writer acquires its write transaction"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }
		const contender = new DatabaseSync(f.database);
		try {
			assert.equal(contender.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
			assert.throws(() => contender.exec("BEGIN IMMEDIATE"), { errcode: 5 }, "the other process holds SQLite's writer lock");
		} finally { contender.close(); }
		fs.writeFileSync(release, "record now");
		recordRun("hot", "Sample during contention", 0, 7);
		await exited;
		assert.equal(fs.existsSync(closed), true);
		assert.deepEqual(loadRunsForAgent("hot").map((row) => row.task), ["Sample during contention", "Migration complete"]);
	} finally {
		fs.writeFileSync(release, "release");
		await exited;
	}
});

test("cold timing conversion retains a sample while an attached rollback-journal writer finishes", async (t) => {
	const f = fixture(t), ready = path.join(f.root, "ready"), write = path.join(f.root, "write"), closed = path.join(f.root, "closed");
	fs.mkdirSync(path.dirname(f.database), { mode: 0o700 });
	const db = new DatabaseSync(f.database);
	db.exec("CREATE TABLE native_writer(value); INSERT INTO native_writer VALUES (1)");
	db.close();
	const writer = spawn(process.execPath, ["--input-type=module", "-e", `
		import fs from "node:fs"; import { DatabaseSync } from "node:sqlite";
		const db = new DatabaseSync(${JSON.stringify(f.database)});
		db.exec("BEGIN IMMEDIATE"); db.exec("INSERT INTO native_writer VALUES (2)");
		fs.writeFileSync(${JSON.stringify(ready)}, "write transaction held");
		setTimeout(() => { db.close(); process.exit(1); }, 5000).unref();
		const timer = setInterval(() => {
			if (!fs.existsSync(${JSON.stringify(write)})) return;
			clearInterval(timer);
			setTimeout(() => { db.exec("COMMIT"); db.close(); fs.writeFileSync(${JSON.stringify(closed)}, "writer closed"); }, 50);
		}, 1);
	`], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
	let error = ""; writer.stderr.setEncoding("utf8"); writer.stderr.on("data", (chunk) => { error += chunk; });
	const exited = new Promise<void>((resolve, reject) => {
		writer.once("error", reject); writer.once("exit", (status) => status === 0 ? resolve() : reject(new Error(error || `Writer exited ${status}`)));
	});
	try {
		const deadline = Date.now() + 5000;
		while (!fs.existsSync(ready)) { assert.ok(Date.now() < deadline, "native writer acquires its write transaction"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }
		const contender = new DatabaseSync(f.database);
		try { assert.throws(() => contender.exec("BEGIN IMMEDIATE"), { errcode: 5 }, "the other process holds SQLite's writer lock"); }
		finally { contender.close(); }
		fs.writeFileSync(write, "record now");
		recordRun("cold", "Sample during conversion", 0, 7);
		await exited;
		assert.equal(fs.existsSync(closed), true);
		recordRun("cold", "Sample after conversion", 0, 8);
		assert.deepEqual(loadRunsForAgent("cold").map((row) => row.task), ["Sample after conversion", "Sample during conversion"]);
	} finally {
		fs.writeFileSync(write, "release");
		await exited;
	}
});

test("cold timing writers retain their sample when SQLite removes another connection's sidecars", async (t) => {
	const f = fixture(t), database = path.join(fs.realpathSync(f.root), "history-index", "run-timing.sqlite"), exists = fs.existsSync, chmod = fs.chmodSync;
	const ready = path.join(f.root, "ready"), release = path.join(f.root, "release"), closed = path.join(f.root, "closed");
	let writer: ReturnType<typeof spawn> | undefined, exited: Promise<void> | undefined, vanished = false;
	const wait = (file: string) => {
		const deadline = Date.now() + 5000;
		while (!exists(file)) { assert.ok(Date.now() < deadline, `native writer publishes ${file}`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }
	};
	const closeWriter = () => {
		if (vanished) return;
		assert.equal(exists(database + "-wal"), true);
		assert.equal(exists(database + "-shm"), true);
		fs.writeFileSync(release, "close"); wait(closed);
		assert.equal(exists(database + "-wal"), false, "SQLite itself removed the WAL while the cold converter remained open");
		assert.equal(exists(database + "-shm"), false);
		vanished = true;
	};
	t.mock.method(fs, "chmodSync", function(file, mode) {
		if (file === database && !writer) {
			const child = spawn(process.execPath, ["--input-type=module", "-e", `import fs from "node:fs"; import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(${JSON.stringify(database)}); db.exec("CREATE TABLE native_sidecar_probe(value)"); fs.writeFileSync(${JSON.stringify(ready)}, "ready"); setTimeout(() => { db.close(); process.exit(1); }, 10_000).unref(); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); db.close(); fs.writeFileSync(${JSON.stringify(closed)}, "closed"); } }, 1);`], { env: process.env, stdio: "ignore" });
			writer = child;
			exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (status) => status === 0 ? resolve() : reject(new Error(`Native writer exited ${status}`))); });
			wait(ready);
		}
		if (file === database + "-wal") closeWriter();
		return chmod.call(this, file, mode);
	});
	syncBuiltinESMExports();
	try {
		recordRun("cold", "Retained cold sample", 0, 7);
		assert.equal(vanished, true, "the native sidecar interleaving was reached");
		assert.equal(loadRunsForAgent("cold")[0]?.task, "Retained cold sample");
	} finally {
		t.mock.restoreAll(); syncBuiltinESMExports();
		if (writer && !exists(closed)) fs.writeFileSync(release, "close");
		await exited;
	}
});

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

test("a paused legacy migration admits a concurrent timing sample and imports the snapshot only once", (t) => {
	const f = fixture(t);
	const original = JSON.stringify({ agent: "other", task: "Legacy sample", ts: 1, status: "ok", duration: 1 }) + "\n";
	fs.writeFileSync(f.file, original);
	const read = fs.readSync;
	let writer: ReturnType<typeof spawnSync> | undefined;
	t.mock.method(fs, "readSync", function(fd, buffer, offset, length, position) {
		const snapshot = read.call(this, fd, buffer, offset, length, position);
		// Hold the actual migration read until another process completes native write admission.
		if (writer === undefined) writer = spawnSync(process.execPath, ["--input-type=module", "-e", `import { recordRun, loadRunsForAgent } from ${JSON.stringify(writerModule)}; recordRun("requested", "Concurrent sample", 0, 7); if (loadRunsForAgent("requested")[0]?.task !== "Concurrent sample") process.exit(1);`], { env: process.env, encoding: "utf8", timeout: 5000 });
		return snapshot;
	});
	syncBuiltinESMExports();
	try { recordRun("requested", "Original sample", 0, 8); }
	finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	assert.ok(writer, "the migration reached the native filesystem read");
	assert.equal(writer.status, 0, writer.stderr);
	assert.deepEqual(loadRunsForAgent("requested").map((row) => row.task), ["Original sample", "Concurrent sample"]);
	assert.deepEqual(loadRunsForAgent("other").map((row) => row.task), ["Legacy sample"], "the transaction rechecks a competing migration's commit");
	assert.equal(fs.readFileSync(f.file, "utf8"), original);
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
	// Hot retention must not race a cold import against best-effort writer admission.
	recordRun("requested", "Migration complete", 0, 0);
	const migrated = new DatabaseSync(f.database, { readOnly: true });
	try {
		assert.equal(migrated.prepare("SELECT key FROM timing_meta WHERE key='legacy-imported'").get()?.key, "legacy-imported");
		assert.equal(loadRunsForAgent("requested")[0]?.task, "Migration complete", "native migration commits before the concurrent retention phase");
	} finally { migrated.close(); }
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
