import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test as nodeTest } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  escalationSchema,
  processSchema,
  resultSchema,
  type Launch,
} from "../../src/agent/contracts.ts";
import { loadSDK } from "../../src/agent/host.ts";
import { release } from "../../src/agent/notifications.ts";
import { resolveActiveEscalation } from "../../src/agent/overseer-sentinel.ts";
import { ensureActor, ownIdentity } from "../../src/agent/process.ts";
import { enqueue, ownerDirectory, read, runDirectory, write } from "../../src/agent/storage.ts";
import { nativeSdkRoot } from "../support/native-sdk.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const providerFixture = path.join(repo, "test/fixtures/overseer-steer-provider.ts");

function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

async function until(check: () => boolean, reason: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${reason}`);
    }
    await delay(20);
  }
}

nodeTest(
  "real Actor pre-settle steer skips redundant overseer-sentinel turn and delivers steer",
  async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync("/tmp/ovr-runner-"));
    const work = path.join(root, "repo");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(work, "src"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const git = (...args: string[]) => {
      execFileSync("git", args, { cwd: work, stdio: "ignore" });
    };
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(work, "src", "allowed.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(work, "README.md"), "committed\n");
    git("add", ".");
    git("commit", "-m", "initial");
    git("checkout", "-b", "feat/work");

    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: [providerFixture],
        defaultProjectTrust: "always",
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );

    const sdkRoot = nativeSdkRoot();
    const sdk = await loadSDK(sdkRoot);
    const owner = "overseer-runner-parent";
    const id = randomUUID();
    const base = ownerDirectory(agentDir, owner);
    const dir = runDirectory(base, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manager = sdk.SessionManager.create(work, dir);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile !== undefined);
    fs.writeFileSync(sessionFile, `${JSON.stringify(manager.getHeader())}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    const launch: Launch = {
      version: 1,
      id,
      rootId: id,
      owner,
      cwd: work,
      agentDir,
      sdk: sdkRoot,
      entry: path.join(repo, "src/agent/index.ts"),
      sessionFile,
      sessionId: manager.getSessionId(),
      prompt: "Implement feature in src/allowed.ts",
      context: "fresh",
      provider: "overseer-fixture",
      model: "native-overseer",
      thinking: "off",
      trusted: true,
      name: "overseer-steer-test",
      contract: {
        scope: ["src"],
        verification: ["echo ok"],
        baseBranch: "main",
      },
      overseer: { enabled: true, judge: "off" },
      createdAt: Date.now(),
    };
    write(path.join(dir, "launch.json"), launch, true);
    write(path.join(base, "attachment.json"), {
      ...ownIdentity(),
      generation: "overseer-runner-test",
      attached: true,
    });
    t.after(async () => {
      const actor = read(path.join(dir, "actor.lock", "process.json"), processSchema);
      write(path.join(base, "attachment.json"), {
        ...ownIdentity(),
        generation: "overseer-runner-test",
        attached: false,
      });
      if (actor !== undefined) {
        await until(() => dead(actor.pid), "actor exit after detachment", 10_000).catch(() => {
          try {
            process.kill(-actor.pid, "SIGKILL");
          } catch {
            // already exited
          }
        });
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    const savedEnv = { ...process.env };
    Object.assign(process.env, {
      PI_OFFLINE: "1",
      OVERSEER_TEST_REPO: work,
    });
    try {
      await ensureActor(base, launch);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, savedEnv);
    }

    enqueue(base, launch, { action: "run" });

    const escPath = path.join(dir, "escalation.json");
    await until(() => fs.existsSync(escPath), "escalation.json written at agent_before_settle");
    const esc = read(escPath, escalationSchema);
    assert.ok(esc !== undefined);
    assert.equal(esc.kind, "scope_violation");
    t.after(() => release(owner, `escalation:${esc.id}`));

    enqueue(base, launch, { action: "steer", prompt: "REVERT_README" });
    resolveActiveEscalation(base, launch, "steered");

    const resultPath = path.join(dir, "result.json");
    await until(() => fs.existsSync(resultPath), "result.json written after steer");
    const result = read(resultPath, resultSchema);
    assert.ok(result !== undefined);
    assert.equal(result.status, "completed");

    const journal = fs.readFileSync(sessionFile, "utf8");
    assert.match(journal, /REVERT_README/u);
    assert.match(journal, /REVERTED/u);
    assert.equal(
      journal.includes("overseer-sentinel"),
      false,
      "Actor-flushed steer must skip redundant overseer-sentinel custom message",
    );
  },
);
