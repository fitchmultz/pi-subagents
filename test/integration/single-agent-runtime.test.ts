import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { findPackageJSON } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Assert } from "typebox/value";
import { ensureActor } from "../../src/agent/process.ts";
import { usageLaunch } from "../support/agent-launch.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assert.notEqual(manifest, undefined);
const sdk = process.env.PI_SINGLE_AGENT_TEST_SDK ?? path.dirname(manifest ?? "");
const seedSchema = Type.Object({
  runId: Type.String(),
  sessionId: Type.String(),
  sessionFile: Type.String(),
  childPid: Type.Integer(),
  bystanderPid: Type.Optional(Type.Integer()),
});
function seed(root: string) {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(root, "seed.json"), "utf8"));
  Assert(seedSchema, value);
  return value;
}
function run(root: string, phase: string, killed = false): string {
  const result = spawnSync(
    process.execPath,
    [path.join(repo, "test/fixtures/single-agent-parent.mjs"), root, repo, sdk, phase],
    { cwd: repo, encoding: "utf8", timeout: 35000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(result.error, undefined, `${phase}: ${result.error?.message ?? ""}`);
  assert.equal(
    result.signal,
    killed ? "SIGKILL" : null,
    `${phase}: ${result.stderr}\n${result.stdout}`,
  );
  assert.equal(result.status, killed ? null : 0, `${phase}: ${result.stderr}\n${result.stdout}`);
  if (phase === "command-polling" || phase === "usage") {
    console.log(result.stdout.trim());
  }
  return result.stderr;
}
async function until(check: () => boolean, reason: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert.ok(Date.now() < deadline, reason);
    // Poll actual durable/native publication or process death, not a readiness sleep.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}
function signalable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function cleanup(root: string): Promise<void> {
  for (const name of [
    "first",
    "second",
    "queue",
    "queuesecond",
    "existing",
    "owned",
    "boundary",
    "replacement",
    "foreground",
    "publication",
  ]) {
    fs.writeFileSync(path.join(root, `release-${name}`), "release");
  }
  const records = fs
    .readdirSync(root, { recursive: true })
    .filter(
      (file): file is string =>
        typeof file === "string" && file.endsWith("actor.lock/process.json"),
    );
  const pids = records.map((file) => {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    Assert(Type.Object({ pid: Type.Integer() }), value);
    return value.pid;
  });
  try {
    await until(
      () => pids.every(dead),
      "owned native actors must exit after main attachment is gone",
    );
  } finally {
    for (const pid of pids) {
      if (!dead(pid)) {
        process.kill(-pid, "SIGKILL");
      }
    }
    for (const file of fs.readdirSync(root, { recursive: true })) {
      if (typeof file === "string" && file.includes("/shells/") && file.endsWith(".json")) {
        const value: unknown = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
        Assert(Type.Object({ pid: Type.Integer() }), value);
        // Permission-denied claims name another user's process; never signal them.
        if (signalable(value.pid)) {
          process.kill(-value.pid, "SIGKILL");
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
for (const phase of [
  "receipt",
  "model-selection",
  "continuation",
  "lineage",
  "queue-drop",
  "queue-drop-two",
  "queue-retain",
  "queue-steer",
  "queue-retain-one",
  "cancellation",
  "dispose",
  "custom-bash",
  "bash-before-registration",
  "trust",
  "accounting-lf",
  "receipt-mutation",
  "generation",
  "parallel-cold-continue",
  "late-guidance",
  "cwd-invalid-missing-resolver",
  "cwd-invalid-missing-setter",
  "cwd-invalid-wrong-owner",
  "cwd-invalid-wrong-directory",
  "cwd-invalid-error",
  "launch-preparation-failure",
  "launch-preparation-fork-failure",
  "inventory",
  "command-polling",
  "dropped-hints",
]) {
  test(`single-agent native ${phase}`, { timeout: 60000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-native-"));
    try {
      run(root, phase);
    } finally {
      await cleanup(root);
    }
  });
}
for (const [phase, diagnostics] of [
  ["bash-shutdown-stale", 1],
  ["bash-shutdown-stale-exited", 1],
  // Darwin's unzoned legacy births cannot be compared across zones; Linux identities are zone-free.
  ["bash-shutdown-timezone", process.platform === "linux" ? 0 : 2],
] as const) {
  test(
    `single-agent ${phase} parent shutdown stops verified owners, spares reused PIDs and reports only true ambiguity`,
    { timeout: 60000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-shutdown-stale-"));
      try {
        const stderr = run(root, phase);
        assert.deepEqual(
          stderr.split("\n").filter((line) => line.startsWith("Child shutdown")),
          Array.from(
            { length: diagnostics },
            () =>
              `Child shutdown ${seed(root).runId}: Cannot verify actor process identity; no signal sent.`,
          ),
          stderr,
        );
      } finally {
        await cleanup(root);
      }
    },
  );
}
test(
  "single-agent native preparation SIGKILL leaves only an unadmitted directory and does not starve saved completion or subsequent launches",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-preparation-"));
    try {
      run(root, "launch-preparation-crash", true);
      const saved = seed(root);
      await until(
        () =>
          fs.existsSync(
            path.join(
              root,
              "agent/sessions/agent-runs",
              saved.sessionId,
              saved.runId,
              "result.json",
            ),
          ) && dead(saved.childPid),
        "valid sibling publishes its interrupted result and exits after parent death",
      );
      run(root, "launch-preparation-reopen");
    } finally {
      await cleanup(root);
    }
  },
);
test(
  "single-agent native cwd captures active parent B, initializes fork C once and restores child-selected D on cold continuation",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-cwd-"));
    try {
      run(root, "cwd");
      await until(() => dead(seed(root).childPid), "old cwd actor actually exits");
      run(root, "cwd-reopen");
    } finally {
      await cleanup(root);
    }
  },
);
test(
  "single-agent actual native runtime shutdown joins admitted filesystem initialization",
  { timeout: 30000 },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-shutdown-"));
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(repo, "test/fixtures/single-agent-shutdown.mjs"), root, repo, sdk],
        { cwd: repo, encoding: "utf8", timeout: 25000 },
      );
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  "single-agent native child usage is recorded exactly once per native entry and never charged to the parent across notice, concurrent inspection, continuation and a fresh reader",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-usage-"));
    try {
      run(root, "usage");
      run(root, "usage-reopen");
    } finally {
      await cleanup(root);
    }
  },
);
test(
  "single-agent continues only owned frozen legacy single-native journals, retaining identity and refusing missing, foreign, retired or duplicate launches",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-saved-"));
    try {
      run(root, "saved-single");
      run(root, "saved-reopen");
    } finally {
      await cleanup(root);
    }
  },
);
test(
  "single-agent legacy-only native queued input survives SIGKILL without canonical storage or invented ownership",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-legacy-"));
    try {
      run(root, "legacy-queue", true);
      run(root, "legacy-reopen");
      run(root, "legacy-again");
      run(root, "legacy-mutation");
    } finally {
      await cleanup(root);
    }
  },
);
for (const crash of [undefined, "before", "after"]) {
  test(
    `single-agent cold stopped-result recovery ${crash === undefined ? "after orderly parent exit" : `after SIGKILL ${crash} native append`}`,
    { timeout: 90000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-cold-"));
      try {
        run(root, "seed");
        const saved = seed(root);
        const result = path.join(
          root,
          "agent/sessions/agent-runs",
          saved.sessionId,
          saved.runId,
          "result.json",
        );
        await until(
          () => fs.existsSync(result) && dead(saved.childPid),
          "parent exit stops the child and retains its canonical result",
        );
        if (crash !== undefined) {
          run(root, `crash-${crash}`, true);
          const evidence: unknown = JSON.parse(
            fs.readFileSync(path.join(root, `crash-${crash}.json`), "utf8"),
          );
          Assert(
            Type.Object({
              entries: Type.Array(
                Type.Object({ type: Type.String(), customType: Type.Optional(Type.String()) }),
              ),
            }),
            evidence,
          );
          assert.equal(
            evidence.entries.filter(
              (entry) => entry.type === "custom_message" && entry.customType === "agent-completion",
            ).length,
            crash === "after" ? 1 : 0,
          );
        }
        run(root, "resume");
        run(root, "reopen");
        run(root, "foreign");
        run(root, "fork-owner");
        if (crash === undefined) {
          run(root, "cold-continue");
        }
      } finally {
        await cleanup(root);
      }
    },
  );
}
test(
  "single-agent actor SIGKILL retains native shell ownership for cold Stop and same-run continuation retry without replay, bystander signals or blocking on another user's proven-reused PID",
  { timeout: 60000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-orphan-"));
    try {
      run(root, "bash-seed-paused", true);
      const saved = seed(root);
      process.kill(saved.childPid, "SIGKILL");
      await until(() => dead(saved.childPid), "actual actor SIGKILL completes");
      for (const line of run(root, "cold-actor-stop").split("\n")) {
        if (line.startsWith("Skipped permission-denied")) {
          t.diagnostic(line);
        }
      }
    } finally {
      await cleanup(root);
    }
  },
);
test(
  "single-agent cold Stop verifies birth and stops an OS-suspended actor and descendants without fabricated exit",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-stop-"));
    try {
      run(root, "bash-seed-paused", true);
      run(root, "cold-stop");
    } finally {
      await cleanup(root);
    }
  },
);
for (const [death, phase] of [
  ["SIGKILL", "bash-seed"],
  ["SIGKILL with reused attachment PID", "bash-parent-reuse"],
] as const) {
  test(
    `single-agent parent ${death} stops native shell work and cold continuation reuses the interrupted child conversation`,
    { timeout: 60000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-parent-exit-"));
      try {
        if (phase === "bash-parent-reuse") {
          const child = spawn(
            process.execPath,
            [path.join(repo, "test/fixtures/single-agent-parent.mjs"), root, repo, sdk, phase],
            { cwd: repo, detached: true, stdio: "inherit", timeout: 35000 },
          );
          const exitSignal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (_code, signal) => resolve(signal));
          });
          assert.equal(exitSignal, "SIGKILL");
        } else {
          run(root, phase, true);
        }
        const saved = seed(root);
        const family: unknown = JSON.parse(
          fs.readFileSync(path.join(root, "shell-family.json"), "utf8"),
        );
        Assert(Type.Object({ pid: Type.Integer(), descendant: Type.Integer() }), family);
        await until(
          () => [saved.childPid, family.pid, family.descendant].every(dead),
          "actor and native shell descendants terminate without any request to the dead parent",
        );
        if (saved.bystanderPid !== undefined) {
          const beat = path.join(root, "parent-bystander-heartbeat");
          const size = fs.statSync(beat).size;
          await until(
            () => fs.statSync(beat).size > size,
            "the reused parent PID survives the actor's actual shutdown",
          );
          process.kill(saved.bystanderPid, 0);
        }
        run(root, "resume-stopped-bash");
      } finally {
        if (fs.existsSync(path.join(root, "seed.json"))) {
          const pid = seed(root).bystanderPid;
          if (pid !== undefined && !dead(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
        await cleanup(root);
      }
    },
  );
}
for (const [name, thrown, error] of [
  ["Error", "new Error('CONTROLLED_SDK_STARTUP_FAILURE')", "CONTROLLED_SDK_STARTUP_FAILURE"],
  ["string", "'CONTROLLED_SDK_STARTUP_TEXT'", "CONTROLLED_SDK_STARTUP_TEXT"],
  ["circular", "Object.assign(failure, { self: failure })", "Unserializable failure"],
  ["BigInt", "7n", "7"],
  ["undefined", "undefined", "undefined"],
] as const) {
  test(
    `single-agent detached actor publishes a canonical failed result when a controlled SDK double throws ${name} at startup`,
    { timeout: 30000 },
    async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-startup-failure-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const sdkDouble = path.join(root, "sdk");
      fs.mkdirSync(path.join(sdkDouble, "dist"), { recursive: true });
      fs.mkdirSync(path.join(sdkDouble, "node_modules"));
      const hostTypebox = findPackageJSON("typebox", path.join(sdk, "dist/index.js"));
      assert.notEqual(hostTypebox, undefined);
      fs.symlinkSync(path.dirname(hostTypebox ?? ""), path.join(sdkDouble, "node_modules/typebox"));
      fs.writeFileSync(
        path.join(sdkDouble, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }),
      );
      fs.writeFileSync(
        path.join(sdkDouble, "dist/index.js"),
        `const failure = {};
export const SessionManager = { open: () => ({}) };
export async function createAgentSessionRuntime() { throw ${thrown}; }
`,
      );
      const base = path.join(root, "owner");
      const directory = path.join(base, "run");
      fs.mkdirSync(directory, { recursive: true });
      const launch = {
        ...usageLaunch(path.join(directory, "child.jsonl")),
        owner: "owner",
        sdk: sdkDouble,
      };
      fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify(launch));
      await ensureActor(base, launch);
      const claim: unknown = JSON.parse(
        fs.readFileSync(path.join(directory, "actor.lock/claim.json"), "utf8"),
      );
      Assert(Type.Object({ token: Type.String() }), claim);
      const exitFile = path.join(directory, `exit-${claim.token}.json`);
      await until(() => fs.existsSync(exitFile), "detached actor exit is recorded");
      const exit: unknown = JSON.parse(fs.readFileSync(exitFile, "utf8"));
      Assert(
        Type.Object({
          code: Type.Union([Type.Integer(), Type.Null()]),
          signal: Type.Union([Type.String(), Type.Null()]),
        }),
        exit,
      );
      assert.deepEqual(
        {
          code: exit.code,
          signal: exit.signal,
          log: fs.readFileSync(path.join(directory, "runner.log"), "utf8"),
        },
        { code: 1, signal: null, log: "" },
      );
      assert.equal(fs.readFileSync(path.join(directory, "output.txt"), "utf8"), "");
      const result: unknown = JSON.parse(
        fs.readFileSync(path.join(directory, "result.json"), "utf8"),
      );
      Assert(Type.Object({ endedAt: Type.Number() }), result);
      assert.deepEqual(result, {
        id: "run",
        owner: "owner",
        status: "failed",
        endedAt: result.endedAt,
        error,
      });
    },
  );
}
