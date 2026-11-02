import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test as nodeTest } from "node:test";
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
import { fixture, inventory, crashedWriter } from "../support/retired-history.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assertDefined(manifest);
const hostRoot = dirname(manifest);
const host = record(readJson(manifest));
const cli = join(hostRoot, text(record(host.bin).pi));
const extension = join(repo, "src/index.ts");

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

nodeTest(
  "actual selected-host CLI preserves retired data through extension load and session_start",
  () => {
    using cleanup = new DisposableStack();
    const root = fixture(cleanup, "cli");
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
    } finally {
      active.close();
    }
  },
);

nodeTest(
  "native deferred completion recovery and tool reconciliation preserve retired SQLite data",
  async (t) => {
    const cleanup = new AsyncDisposableStack();
    t.after(() => cleanup.disposeAsync());
    const root = fixture(cleanup, "deferred");
    const agentDir = join(root, "agent");
    const directory = join(agentDir, "history-index");
    const outside = join(root, "sessions", "sentinel.jsonl");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
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
  },
);
