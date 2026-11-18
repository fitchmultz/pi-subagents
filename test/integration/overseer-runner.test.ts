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
  admissionSchema,
  escalationSchema,
  processSchema,
  resultSchema,
  type Launch,
} from "../../src/agent/contracts.ts";
import { loadSDK } from "../../src/agent/host.ts";
import { prepareOverseerReviewAction } from "../../src/agent/overseer-review.ts";
import { ensureActor, ownIdentity } from "../../src/agent/process.ts";
import { stopRun } from "../../src/agent/shutdown.ts";
import {
  conversation,
  enqueue,
  ownerDirectory,
  read,
  runDirectory,
  write,
} from "../../src/agent/storage.ts";
import { renderReceipt } from "../../src/agent/view.ts";
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

for (const scenario of [
  "correction at turn_end",
  "correction at agent_before_settle",
  "approval at turn_end",
  "stop at agent_before_settle",
] as const) {
  nodeTest(`real Actor: ${scenario}`, async (t) => {
    const checkpoint = scenario.endsWith("at turn_end") ? "turn_end" : "agent_before_settle";
    const root = fs.realpathSync(fs.mkdtempSync("/tmp/ovr-runner-"));
    // The run works in a linked worktree. The main checkout of the same repository stays on
    // the base branch, where the provider fixture commits as another session would.
    const checkout = path.join(root, "checkout");
    const work = path.join(root, "repo");
    const agentDir = path.join(root, "agent");
    const toolGate = path.join(root, "tool-gate");
    fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    const git = (...args: string[]) => {
      execFileSync("git", args, { cwd: checkout, stdio: "ignore" });
    };
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(checkout, "src", "allowed.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(checkout, "README.md"), "committed\n");
    git("add", ".");
    git("commit", "-m", "initial");
    git("worktree", "add", "-b", "feat/work", work);

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
      OVERSEER_TEST_SIBLING: checkout,
      ...(checkpoint === "turn_end" ? { OVERSEER_TEST_TOOL_GATE: toolGate } : {}),
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

    if (scenario === "approval at turn_end") {
      fs.writeFileSync(toolGate, "");
    } else if (checkpoint === "turn_end") {
      await until(() => fs.existsSync(`${toolGate}.ready`), "bash result at the first turn");
      const guidance = enqueue(base, launch, {
        action: "steer",
        prompt: "EARLIER_GUIDANCE",
      });
      const admission = path.join(conversation(base, launch), "admissions", `${guidance}.json`);
      await until(
        () => read(admission, admissionSchema)?.state === "accepted",
        "earlier guidance accepted by the active actor",
      );
      fs.writeFileSync(toolGate, "");
    }

    const escPath = path.join(dir, "escalation.json");
    await until(
      () => fs.existsSync(escPath) || /UNSTEERED/u.test(fs.readFileSync(sessionFile, "utf8")),
      `escalation.json written at ${checkpoint}`,
    );
    assert.equal(
      fs.readFileSync(sessionFile, "utf8").includes("UNSTEERED"),
      false,
      "ordinary guidance must not release a pause before the correction",
    );
    const esc = read(escPath, escalationSchema);
    assert.ok(esc !== undefined);
    assert.equal(esc.kind, "scope_violation");
    assert.deepEqual(esc.changedFiles, ["README.md"]);
    const resultPath = path.join(dir, "result.json");
    if (scenario === "stop at agent_before_settle") {
      stopRun(base, launch, undefined, (error) => assert.fail(error));
      await until(() => fs.existsSync(resultPath), "paused stop saves the native result");
      assert.equal(read(resultPath, resultSchema)?.status, "stopped");
      const journal = fs.readFileSync(sessionFile, "utf8");
      assert.match(journal, /DRIFTED/u);
      assert.doesNotMatch(journal, /REVERTED|UNSTEERED/u, "stop does not start a new request");
      assert.equal(fs.existsSync(escPath), false, "stopping removes the live pause");
      return;
    }

    if (scenario === "approval at turn_end") {
      // This is deliberately an instruction. Approving must not send it to the child.
      const { review, released } = prepareOverseerReviewAction(base, launch, {
        action: "review",
        verdict: "approved",
        summary: "REVERT_README",
      });
      assert.equal(released, true);
      const receipt = renderReceipt(base, launch, undefined, {
        receipt: "review",
        review,
        released,
      });
      assert.match(receipt.content[0]?.text ?? "", /not sent to the child.*continue/u);
      await until(() => fs.existsSync(resultPath), "approving resumes the native run");
      const result = read(resultPath, resultSchema);
      assert.equal(result?.status, "completed");
      assert.deepEqual(result.changedFiles, ["README.md"]);
      const journal = fs.readFileSync(sessionFile, "utf8");
      assert.match(journal, /UNSTEERED/u, "a model request ran after approval");
      assert.doesNotMatch(
        journal,
        /REVERT_README/u,
        "approval evidence never enters child context",
      );
      return;
    }

    enqueue(base, launch, { action: "steer", prompt: "REVERT_README" });

    await until(
      () => /REVERTED|UNSTEERED/u.test(fs.readFileSync(sessionFile, "utf8")),
      "first model response after the pause",
    );
    const firstResponse = fs.readFileSync(sessionFile, "utf8");
    assert.equal(
      firstResponse.includes("UNSTEERED"),
      false,
      "the next model request sees the correction",
    );
    if (checkpoint === "turn_end") {
      assert.match(firstResponse, /EARLIER_GUIDANCE/u, "ordinary queued guidance is preserved");
    }

    await until(() => fs.existsSync(resultPath), "result.json written after steer");
    const result = read(resultPath, resultSchema);
    assert.ok(result !== undefined);
    assert.equal(result.status, "completed");
    // The child reverted its only edit. The other session's commit is not this run's change.
    assert.equal(result.changedFiles, undefined);
    assert.equal(
      execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: work, encoding: "utf8" }),
      "other session\n",
    );

    const journal = fs.readFileSync(sessionFile, "utf8");
    assert.equal(journal.match(/REVERT_README/gu)?.length, 1, "the correction is published once");
    assert.match(journal, /REVERTED/u);
    assert.equal(
      journal.includes("overseer-sentinel"),
      false,
      "a correction needs no generic resume reminder",
    );
  });
}
