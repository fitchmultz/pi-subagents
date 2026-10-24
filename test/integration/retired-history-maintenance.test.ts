import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import agents from "../../src/agent/index.ts";
import { ownerDirectory, write } from "../../src/agent/storage.ts";
import { usageLaunch } from "../support/agent-launch.ts";
import {
  assertDefined,
  parseJson,
  readJson,
  record,
  strings,
  text,
} from "../support/assertions.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { until } from "../support/observation-child.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assertDefined(manifest);
const hostRoot = dirname(manifest);
const host = record(readJson(manifest));
const cli = join(hostRoot, text(record(host.bin).pi));
const extension = resolve(process.env.PI_RETIRED_HISTORY_EXTENSION ?? join(repo, "src/index.ts"));
const evidence = process.env.PI_RETIRED_HISTORY_EVIDENCE_DIR;
const generation = "00000000-0000-4000-8000-000000000001.sqlite";
const manifestName = `${"a".repeat(64)}.json`;

function fixture(label: string): string {
  if (evidence !== undefined) {
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
  }
  const root = mkdtempSync(join(evidence ?? tmpdir(), `history-${label}-`));
  mkdirSync(join(root, "agent", "history-index"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "sessions"));
  writeFileSync(join(root, "sessions", "sentinel.jsonl"), '{"synthetic":"keep"}\n');
  return root;
}

function dispose(root: string): void {
  if (evidence === undefined) {
    rmSync(root, { recursive: true, force: true });
  }
}

function inventory(directory: string): readonly object[] {
  return readdirSync(directory)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const file = join(directory, name);
      const stat = lstatSync(file);
      return {
        name,
        inode: stat.ino,
        size: stat.size,
        mode: stat.mode,
        uid: stat.uid,
        links: stat.nlink,
        symlink: stat.isSymbolicLink(),
        sha256: stat.isFile()
          ? createHash("sha256").update(readFileSync(file)).digest("hex")
          : null,
      };
    });
}

function bytes(directory: string): { logical: number; allocated: number } {
  return readdirSync(directory).reduce(
    (total, name) => {
      const stat = lstatSync(join(directory, name));
      return {
        logical: total.logical + stat.size,
        allocated: total.allocated + stat.blocks * 512,
      };
    },
    { logical: 0, allocated: 0 },
  );
}

function crashedWriter(directory: string, committed: boolean): void {
  const writer = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
import { writeSync } from "node:fs";
import { join } from "node:path";
const directory = process.argv[1];
const databases = [];
for (const name of [${JSON.stringify(generation)}, ${JSON.stringify(`${generation}.ingest.sqlite`)}, "run-timing.sqlite"]) {
  const db = new DatabaseSync(join(directory, name));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0");
  db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('committed')");
  db.exec("BEGIN IMMEDIATE; INSERT INTO fixture VALUES ('pending')");
  if (${committed}) db.exec("COMMIT");
  databases.push(db);
}
writeSync(1, "WAL_READY " + databases.length + "\\n");
process.kill(process.pid, "SIGKILL");`,
      directory,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(writer.error, undefined);
  assert.equal(writer.signal, "SIGKILL");
  assert.equal(writer.stdout, "WAL_READY 3\n", writer.stderr);
  for (const name of [generation, `${generation}.ingest.sqlite`, "run-timing.sqlite"]) {
    assert.ok(lstatSync(join(directory, `${name}-wal`)).size > 0);
    assert.ok(lstatSync(join(directory, `${name}-shm`)).isFile());
  }
  writeFileSync(join(directory, manifestName), JSON.stringify({ file: generation }), {
    mode: 0o600,
  });
}

function loadActualCli(root: string): void {
  const observer = join(root, "observer.mjs");
  writeFileSync(
    observer,
    `import { writeFileSync } from "node:fs";
export default function(pi) {
  pi.on("session_start", (_event, ctx) => {
    writeFileSync(${JSON.stringify(join(root, "loaded.json"))}, JSON.stringify(pi.getActiveTools()));
    ctx.shutdown();
  });
}`,
  );
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--mode",
      "rpc",
      "--session-dir",
      join(root, "sessions"),
      "-ne",
      "-ns",
      "-np",
      "-nc",
      "--no-themes",
      "--approve",
      "--tools",
      "delegate,agent_runs,intercom",
      "-e",
      extension,
      "-e",
      observer,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_INTERCOM_RUNTIME_DIR: join(root, "ic"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        JITI_FS_CACHE: join(root, "jiti"),
      },
      encoding: "utf8",
      input: "",
      timeout: 30_000,
    },
  );
  writeFileSync(join(root, "cli.stdout.jsonl"), result.stdout);
  writeFileSync(join(root, "cli.stderr.txt"), result.stderr);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Failed to load extension|Extension error/);
  assert.deepEqual(
    strings(readJson(join(root, "loaded.json"))).toSorted((a, b) => a.localeCompare(b)),
    ["agent_runs", "delegate", "intercom"],
  );
}

test("actual selected-host CLI leaves stale, unknown, linked and active legacy data untouched", () => {
  const root = fixture("cli");
  const directory = join(root, "agent", "history-index");
  const outside = join(root, "sessions", "sentinel.jsonl");
  crashedWriter(directory, true);
  writeFileSync(join(directory, "unknown.keep"), "foreign contents must survive\n");
  symlinkSync(outside, join(directory, "foreign-link"));
  linkSync(outside, join(directory, "foreign-hard-link"));
  const active = new DatabaseSync(join(directory, "active.sqlite"));
  try {
    active.exec("PRAGMA journal_mode=WAL; CREATE TABLE heartbeat(value TEXT)");
    const before = inventory(directory);
    const sentinel = readFileSync(outside);
    loadActualCli(root);
    assert.deepEqual(
      inventory(directory),
      before,
      "startup preserves old files, identities and bytes",
    );
    assert.deepEqual(readFileSync(outside), sentinel);
    active.exec("INSERT INTO heartbeat VALUES ('still writable')");
    assert.equal(active.prepare("SELECT count(*) AS n FROM heartbeat").get()?.n, 1);
    console.log(
      JSON.stringify({
        host: host.version,
        hostRoot,
        cli,
        extension,
        legacyMembers: before.length,
        removed: 0,
        errors: 0,
      }),
    );
  } finally {
    active.close();
    dispose(root);
  }
});

test("native deferred completion recovery and tool reconciliation preserve retired SQLite data", async (t) => {
  const root = fixture("deferred");
  const agentDir = join(root, "agent");
  const directory = join(agentDir, "history-index");
  const outside = join(root, "sessions", "sentinel.jsonl");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cleanup = new AsyncDisposableStack();
  t.after(() => cleanup.disposeAsync());
  cleanup.defer(() => dispose(root));
  cleanup.defer(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  crashedWriter(directory, true);
  writeFileSync(join(directory, "unknown.keep"), "foreign contents must survive\n");
  symlinkSync(outside, join(directory, "foreign-link"));
  linkSync(outside, join(directory, "foreign-hard-link"));
  const active = new DatabaseSync(join(directory, "active.sqlite"));
  cleanup.defer(() => active.close());
  active.exec("PRAGMA journal_mode=WAL; CREATE TABLE heartbeat(value TEXT)");
  const before = inventory(directory);
  const sentinel = readFileSync(outside);
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Synthetic archive owner", timestamp: 1 });
  const owner = manager.getSessionId();
  const id = "archive-deferred";
  const base = ownerDirectory(agentDir, owner);
  write(join(base, id, "launch.json"), {
    ...usageLaunch(join(root, "unused-child.jsonl")),
    owner,
    id,
    rootId: id,
  });
  write(join(base, id, "result.json"), { owner, id, status: "completed", endedAt: 2 });
  writeFileSync(join(base, id, "output.txt"), "Synthetic recovered completion");
  const native = await createNativeSessionFixture({
    cwd: root,
    agentDir,
    sessionManager: manager,
    configure: agents,
    bindExtensions: false,
  });
  cleanup.defer(async () => {
    try {
      await native.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      await native.dispose();
    }
  });
  await native.session.bindExtensions({ mode: "print" });
  const receipts = () =>
    manager
      .getEntries()
      .flatMap((entry) =>
        entry.type === "custom_message" && entry.customType === "agent-completion" ? [entry] : [],
      );
  await until(() => receipts().length === 1, "native background completion is published", 5_000);
  await native.session.waitForIdle();
  assert.equal(record(receipts()[0]?.details).id, id);
  const sessionFile = manager.getSessionFile();
  assertDefined(sessionFile);
  assert.ok(
    readFileSync(sessionFile, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => record(parseJson(line)))
      .some((entry) => entry.type === "custom_message" && record(entry.details).id === id),
    "the recovery receipt must reach the actual native journal",
  );
  assert.deepEqual(inventory(directory), before, "deferred recovery preserves retired files");
  const runs = native.session.agent.state.tools.find((tool) => tool.name === "agent_runs");
  assertDefined(runs);
  assert.equal(record((await runs.execute("archive-list", { action: "list" })).details).total, 1);
  await runs.execute("archive-inspect", { action: "inspect", id });
  await native.session.waitForIdle();
  assert.equal(receipts().length, 1, "explicit reconciliation does not duplicate recovery");
  assert.deepEqual(inventory(directory), before, "tool reconciliation preserves retired files");
  assert.deepEqual(readFileSync(outside), sentinel);
  active.exec("INSERT INTO heartbeat VALUES ('still writable after recovery')");
  assert.equal(active.prepare("SELECT count(*) AS n FROM heartbeat").get()?.n, 1);
  console.log(
    JSON.stringify({
      host: host.version,
      recoveredReceipts: 1,
      legacyMembers: before.length,
      removed: 0,
      errors: 0,
    }),
  );
});

for (const committed of [false, true]) {
  test(`cold archive preserves the complete crash recovery set, committed=${committed}`, () => {
    const root = fixture(committed ? "committed" : "uncommitted");
    const source = join(root, "agent", "history-index");
    const archive = join(root, "archive");
    const destination = join(archive, "history-index");
    try {
      crashedWriter(source, committed);
      const before = inventory(source);
      const identity = lstatSync(source).ino;
      const beforeBytes = bytes(source);
      mkdirSync(archive, { mode: 0o700 });
      assert.ok(existsSync(source) && !existsSync(destination), "pre-rename interruption state");
      renameSync(source, destination);
      assert.equal(existsSync(source), false);
      assert.equal(lstatSync(destination).ino, identity);
      assert.deepEqual(inventory(destination), before);
      assert.deepEqual(bytes(destination), beforeBytes);
      assert.ok(!existsSync(source) && existsSync(destination), "post-rename and rerun state");
      const working = join(root, "working");
      cpSync(destination, working, { recursive: true });
      for (const name of [generation, `${generation}.ingest.sqlite`, "run-timing.sqlite"]) {
        const db = new DatabaseSync(join(working, name));
        try {
          assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
          assert.deepEqual(
            db
              .prepare("SELECT value FROM fixture ORDER BY rowid")
              .all()
              .map((row) => row.value),
            committed ? ["committed", "pending"] : ["committed"],
          );
        } finally {
          db.close();
        }
      }
      assert.deepEqual(inventory(destination), before, "recovery never modifies retained archive");
      assert.equal(
        readFileSync(join(root, "sessions", "sentinel.jsonl"), "utf8"),
        '{"synthetic":"keep"}\n',
      );
      console.log(
        JSON.stringify({
          committed,
          archiveMembers: before.length,
          beforeBytes,
          afterArchiveBytes: bytes(destination),
          recoveredDatabases: 3,
          originalFilesDeleted: 0,
          errors: 0,
        }),
      );
    } finally {
      dispose(root);
    }
  });
}

test("rename cannot isolate an active SQLite handle or prevent an old writer relaunch", () => {
  const root = fixture("active");
  const source = join(root, "agent", "history-index");
  const destination = join(root, "archive");
  const active = new DatabaseSync(join(source, "run-timing.sqlite"));
  try {
    active.exec("PRAGMA journal_mode=WAL; CREATE TABLE heartbeat(value TEXT)");
    renameSync(source, destination);
    active.exec("INSERT INTO heartbeat VALUES ('written after rename')");
    assert.equal(active.prepare("SELECT count(*) AS n FROM heartbeat").get()?.n, 1);
    mkdirSync(source);
    writeFileSync(join(source, "run-timing.sqlite"), "recreated by synthetic old launcher");
    assert.ok(existsSync(source) && existsSync(destination), "both-present means stop, not rerun");
    assert.equal(
      readFileSync(join(source, "run-timing.sqlite"), "utf8"),
      "recreated by synthetic old launcher",
    );
  } finally {
    active.close();
    dispose(root);
  }
});
