import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { until } from "../support/observation-child.ts";
import { fixture, crashedWriter, generation, inventory } from "../support/retired-history.ts";

const command = fileURLToPath(
  new URL("../../scripts/archive-retired-history.mjs", import.meta.url),
);
const uid = process.getuid?.();
assert.ok(uid !== undefined);

function elevated(args: readonly string[]) {
  const root = process.geteuid?.() === 0;
  const result = spawnSync(
    root ? process.execPath : "/usr/bin/sudo",
    root ? args : ["-n", "--", process.execPath, ...args],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.error, undefined);
  return result;
}
function invoke(root: string, action: string, options: readonly string[] = []) {
  return elevated([
    command,
    action,
    "--record",
    join(root, "record.json"),
    "--owner-uid",
    String(uid),
    ...options,
  ]);
}
function prepare(root: string) {
  return invoke(root, "prepare", [
    "--source",
    join(root, "agent", "history-index"),
    "--archive",
    join(root, "archive"),
    "--quiesced",
  ]);
}
function success(result: ReturnType<typeof invoke>) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
}
function stopped(result: ReturnType<typeof invoke>, reason: RegExp) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, reason);
  assert.match(
    result.stderr,
    /^\[retired-history\] E_[A-Z_]+\nStop\. Preserve the external record and both locations; do not delete, merge or retry blindly\. See the maintenance guide\. Private paths, contents and inspector output are not printed\.\n$/,
  );
}

for (const committed of [false, true]) {
  test(`shipped archive CLI preserves the recovery set and reconciles interrupted/rerun states, committed=${committed}`, (t) => {
    const root = realpathSync(fixture("route"));
    t.diagnostic(`Synthetic archive evidence retained at ${root}`);
    const source = join(root, "agent", "history-index");
    const archive = join(root, "archive", "history-index");
    crashedWriter(source, committed);
    const before = inventory(source);
    const identity = lstatSync(source).ino;
    const sentinel = readFileSync(join(root, "sessions", "sentinel.jsonl"));
    success(prepare(root));
    assert.deepEqual(inventory(source), before, "preparation cannot recover or alter originals");
    assert.equal(
      existsSync(archive),
      false,
      "preparation is an interruption boundary before the move",
    );
    const record = readFileSync(join(root, "record.json"));
    success(prepare(root));
    success(invoke(root, "inspect"));
    success(invoke(root, "archive", ["--quiesced"]));
    assert.equal(existsSync(source), false);
    assert.equal(lstatSync(archive).ino, identity);
    assert.deepEqual(
      inventory(archive),
      before,
      "the command preserves all file identities and bytes",
    );
    success(invoke(root, "archive", ["--quiesced"]));
    assert.equal(existsSync(source), false, "completed retry must not recreate the source");
    assert.equal(
      lstatSync(archive).ino,
      identity,
      "completed retry must not move the archive again",
    );
    assert.deepEqual(inventory(archive), before);
    assert.deepEqual(
      readFileSync(join(root, "record.json")),
      record,
      "there is no mutable success marker",
    );
    const working = join(root, "disposable-recovery");
    cpSync(archive, working, { recursive: true });
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
    assert.deepEqual(inventory(archive), before, "only a disposable complete copy is recovered");
    assert.deepEqual(readFileSync(join(root, "sessions", "sentinel.jsonl")), sentinel);
    mkdirSync(source);
    writeFileSync(join(source, "run-timing.sqlite"), "synthetic relaunched old writer");
    const recreated = inventory(source);
    stopped(invoke(root, "archive", ["--quiesced"]), /E_AMBIGUOUS_PATHS/);
    assert.deepEqual(inventory(source), recreated);
    assert.deepEqual(inventory(archive), before, "ambiguous retry preserves both trees");
  });
}

const unsafe = [
  {
    name: "unknown entry",
    reason: /E_UNKNOWN_MEMBER/,
    mutate: (root: string) =>
      writeFileSync(join(root, "agent", "history-index", "unknown.keep"), "keep"),
  },
  {
    name: "symbolic link",
    reason: /E_MEMBER_TYPE/,
    mutate: (root: string) => {
      renameSync(
        join(root, "agent", "history-index", "run-timing.sqlite"),
        join(root, "outside.sqlite"),
      );
      symlinkSync(
        join(root, "outside.sqlite"),
        join(root, "agent", "history-index", "run-timing.sqlite"),
      );
    },
  },
  {
    name: "hard link",
    reason: /E_MEMBER_TYPE/,
    mutate: (root: string) =>
      linkSync(
        join(root, "agent", "history-index", "run-timing.sqlite"),
        join(root, "outside.sqlite"),
      ),
  },
  {
    name: "foreign ownership",
    reason: /E_FOREIGN_OWNER/,
    mutate: (root: string) => {
      const file = join(root, "agent", "history-index", "run-timing.sqlite");
      chmodSync(file, 0o644);
      success(
        elevated([
          "--input-type=module",
          "-e",
          "import {chownSync} from 'node:fs'; chownSync(process.argv[1], Number(process.argv[2]), Number(process.argv[2]));",
          file,
          String(uid + 1),
        ]),
      );
    },
  },
  {
    name: "unsafe permissions",
    reason: /E_UNSAFE_MODE/,
    mutate: (root: string) =>
      chmodSync(join(root, "agent", "history-index", "run-timing.sqlite"), 0o666),
  },
];
for (const scenario of unsafe) {
  test(`shipped archive CLI refuses ${scenario.name} before reservation`, (t) => {
    const root = realpathSync(fixture("refused"));
    t.diagnostic(`Synthetic refusal evidence retained at ${root}`);
    const source = join(root, "agent", "history-index");
    crashedWriter(source, true);
    scenario.mutate(root);
    const before = inventory(source);
    const sentinel = readFileSync(join(root, "sessions", "sentinel.jsonl"));
    stopped(prepare(root), scenario.reason);
    assert.deepEqual(inventory(source), before);
    assert.equal(existsSync(join(root, "archive")), false);
    assert.equal(existsSync(join(root, "record.json")), false);
    assert.deepEqual(readFileSync(join(root, "sessions", "sentinel.jsonl")), sentinel);
  });
}

const drift = [
  {
    name: "changed recorded bytes",
    reason: /E_INVENTORY_CHANGED/,
    mutate: (root: string) =>
      writeFileSync(
        join(root, "agent", "history-index", "run-timing.sqlite"),
        "PRIVATE_SENTINEL_DO_NOT_PRINT",
      ),
  },
  {
    name: "replaced source directory",
    reason: /E_SOURCE_CHANGED/,
    mutate: (root: string) => {
      renameSync(join(root, "agent", "history-index"), join(root, "preserved-source"));
      cpSync(join(root, "preserved-source"), join(root, "agent", "history-index"), {
        recursive: true,
      });
    },
  },
  {
    name: "replaced container",
    reason: /E_CONTAINER_CHANGED/,
    mutate: (root: string) => {
      renameSync(join(root, "archive"), join(root, "preserved-container"));
      mkdirSync(join(root, "archive"), { mode: 0o700 });
    },
  },
  {
    name: "unexpected destination",
    reason: /E_AMBIGUOUS_PATHS/,
    mutate: (root: string) => mkdirSync(join(root, "archive", "history-index")),
  },
  {
    name: "record symlink",
    reason: /E_INSPECTION_FAILED/,
    mutate: (root: string) => {
      renameSync(join(root, "record.json"), join(root, "preserved-record.json"));
      symlinkSync(join(root, "preserved-record.json"), join(root, "record.json"));
    },
  },
];
for (const scenario of drift) {
  test(`shipped archive CLI stops on ${scenario.name} after preparation`, (t) => {
    const root = realpathSync(fixture("drift"));
    t.diagnostic(`Synthetic drift evidence retained at ${root}`);
    const source = join(root, "agent", "history-index");
    crashedWriter(source, true);
    success(prepare(root));
    scenario.mutate(root);
    const before = inventory(source);
    stopped(invoke(root, "archive", ["--quiesced"]), scenario.reason);
    assert.deepEqual(inventory(source), before);
    assert.ok(existsSync(source), "ambiguous state must not move or remove the source");
  });
}

test(
  "shipped archive CLI requires explicit operator acknowledgment and refuses a different filesystem",
  { skip: process.platform !== "linux" },
  (t) => {
    const root = realpathSync(fixture("cross-device"));
    t.diagnostic(`Synthetic device evidence retained at ${root}`);
    const source = join(root, "agent", "history-index");
    crashedWriter(source, true);
    const before = inventory(source);
    stopped(
      invoke(root, "prepare", ["--source", source, "--archive", join(root, "archive")]),
      /E_QUIESCENCE_ACK/,
    );
    const other = realpathSync(mkdtempSync("/dev/shm/history-other-"));
    assert.notEqual(
      lstatSync(source).dev,
      lstatSync(other).dev,
      "fixture must use a real different device",
    );
    stopped(
      invoke(root, "prepare", [
        "--source",
        source,
        "--archive",
        join(other, "archive"),
        "--quiesced",
      ]),
      /E_CROSS_DEVICE/,
    );
    assert.deepEqual(inventory(source), before);
    assert.equal(existsSync(join(other, "archive")), false);
    assert.equal(existsSync(join(root, "record.json")), false);
  },
);

async function hold(t: TestContext, root: string, writable: boolean): Promise<() => Promise<void>> {
  const ready = join(root, writable ? "writer.ready" : "reader.ready");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {DatabaseSync} from 'node:sqlite'; import {writeFileSync, openSync, readSync, closeSync} from 'node:fs';
${writable ? "const db = new DatabaseSync(process.argv[1]); db.exec(\"BEGIN IMMEDIATE; INSERT INTO fixture VALUES ('held writer')\");" : 'const fd = openSync(process.argv[1], "r"); readSync(fd, Buffer.alloc(1), 0, 1, 0);'}
writeFileSync(process.argv[2], "SQLITE_HELD\\n");
process.stdin.resume(); process.stdin.once('end', () => {${writable ? "db.close();" : "closeSync(fd);"}});`,
      join(root, "agent", "history-index", "run-timing.sqlite"),
      ready,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
    }
    await exited;
  });
  await until(() => existsSync(ready), "actual SQLite child holds its handle", 5_000);
  assert.equal(readFileSync(ready, "utf8"), "SQLITE_HELD\n");
  return async () => {
    child.stdin.end();
    assert.equal(await exited, 0);
  };
}

test("shipped archive CLI refuses actual SQLite writers and later raw database readers despite operator acknowledgment", async (t) => {
  const root = realpathSync(fixture("handles"));
  t.diagnostic(`Synthetic handle evidence retained at ${root}`);
  const source = join(root, "agent", "history-index");
  crashedWriter(source, true);
  const releaseWriter = await hold(t, root, true);
  const active = inventory(source);
  stopped(prepare(root), /E_OPEN_HANDLES/);
  assert.deepEqual(inventory(source), active);
  assert.equal(existsSync(join(root, "archive")), false);
  assert.equal(existsSync(join(root, "record.json")), false);
  await releaseWriter();
  success(prepare(root));
  const record = readFileSync(join(root, "record.json"));
  const releaseReader = await hold(t, root, false);
  const reading = inventory(source);
  stopped(invoke(root, "archive", ["--quiesced"]), /E_OPEN_HANDLES/);
  assert.deepEqual(inventory(source), reading);
  assert.deepEqual(readFileSync(join(root, "record.json")), record);
  await releaseReader();
  success(invoke(root, "archive", ["--quiesced"]));
  assert.equal(existsSync(source), false);
});

for (const foreignOwner of [false, true]) {
  test(`shipped archive CLI refuses an unsafe ancestor chain, foreignOwner=${foreignOwner}`, (t) => {
    const root = realpathSync(fixture("ancestors"));
    t.diagnostic(`Synthetic ancestor evidence retained at ${root}`);
    const source = join(root, "agent", "history-index");
    crashedWriter(source, true);
    chmodSync(root, 0o755);
    mkdirSync(join(root, "records"), { mode: 0o700 });
    mkdirSync(join(root, "untrusted"), { mode: 0o755 });
    mkdirSync(join(root, "untrusted", "private"), { mode: 0o700 });
    if (foreignOwner) {
      success(
        elevated([
          "--input-type=module",
          "-e",
          "import {chownSync} from 'node:fs'; chownSync(process.argv[1], Number(process.argv[2]), Number(process.argv[2]));",
          join(root, "untrusted"),
          String(uid + 1),
        ]),
      );
    } else {
      chmodSync(join(root, "untrusted"), 0o777);
    }
    const before = inventory(source);
    stopped(
      elevated([
        command,
        "prepare",
        "--record",
        join(root, "records", "plan.json"),
        "--owner-uid",
        String(uid),
        "--source",
        source,
        "--archive",
        join(root, "untrusted", "private", "archive"),
        "--quiesced",
      ]),
      foreignOwner ? /E_ANCESTOR_OWNER/ : /E_ANCESTOR_WRITABLE/,
    );
    assert.deepEqual(inventory(source), before);
    assert.equal(existsSync(join(root, "untrusted", "private", "archive")), false);
    assert.equal(existsSync(join(root, "records", "plan.json")), false);
  });
}
