import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { findPackageJSON } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Assert } from "typebox/value";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assert.notEqual(manifest, undefined);
const sdk = process.env.PI_SINGLE_AGENT_TEST_SDK ?? path.dirname(manifest ?? "");
const seedSchema = Type.Object({
  runId: Type.String(),
  sessionId: Type.String(),
  sessionFile: Type.String(),
  childPid: Type.Integer(),
});
function seed(root: string) {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(root, "seed.json"), "utf8"));
  Assert(seedSchema, value);
  return value;
}
function run(root: string, phase: string, killed = false): void {
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
        if (!dead(value.pid)) {
          process.kill(-value.pid, "SIGKILL");
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
for (const phase of [
  "receipt",
  "continuation",
  "queue-drop",
  "queue-retain",
  "cancellation",
  "dispose-wait",
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
  "single-agent native finalized usage charges once across concurrent waits, discard, inspect, continuation and a fresh reader",
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
    `single-agent cold completion ${crash === undefined ? "after orderly parent exit" : `after SIGKILL ${crash} native append`}`,
    { timeout: 90000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-cold-"));
      try {
        run(root, "seed");
        const saved = seed(root);
        fs.writeFileSync(path.join(root, "release-first"), "release");
        const result = path.join(
          root,
          "agent/sessions/agent-runs",
          saved.sessionId,
          saved.runId,
          "result.json",
        );
        await until(
          () => fs.existsSync(result) && dead(saved.childPid),
          "canonical result publishes and actor exits while native main is offline",
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
  "single-agent actor SIGKILL retains native shell ownership for cold Stop without unread commands, fabricated result or bystander signals",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-orphan-"));
    try {
      run(root, "bash-seed", true);
      const saved = seed(root);
      process.kill(saved.childPid, "SIGKILL");
      await until(() => dead(saved.childPid), "actual actor SIGKILL completes");
      run(root, "cold-actor-stop");
    } finally {
      await cleanup(root);
    }
  },
);
test(
  "single-agent main SIGKILL preserves actual native shell work; cold same-owner Stop verifies birth and stops actor/descendants without fabricated exit",
  { timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-stop-"));
    try {
      run(root, "bash-seed", true);
      run(root, "cold-stop");
    } finally {
      await cleanup(root);
    }
  },
);
