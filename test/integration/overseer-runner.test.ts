import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
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
import { notifications, release } from "../../src/agent/notifications.ts";
import { resolveActiveEscalation } from "../../src/agent/overseer-pause.ts";
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
import { record } from "../support/assertions.ts";

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

async function startChild(
  t: TestContext,
  prompt: string,
  options: { judge?: string; holdBash?: boolean } = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/ovr-runner-"));
  // The run works in a linked worktree. The main checkout of the same repository stays on
  // the base branch, where the provider fixture commits as another session would.
  const checkout = path.join(root, "checkout");
  const work = path.join(root, "repo");
  const agentDir = path.join(root, "agent");
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
    prompt,
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
    overseer: { enabled: true, judge: options.judge ?? "off" },
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

  const judgeInput = path.join(root, "judge-input.json");
  const toolGate = path.join(root, "tool-gate");
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    PI_OFFLINE: "1",
    OVERSEER_TEST_REPO: work,
    OVERSEER_TEST_SIBLING: checkout,
    OVERSEER_TEST_JUDGE_INPUT: judgeInput,
    ...(options.holdBash === true ? { OVERSEER_TEST_TOOL_GATE: toolGate } : {}),
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
  return { base, dir, judgeInput, launch, owner, sdk, sessionFile, toolGate, work };
}

nodeTest(
  "real Actor sees the pre-settle correction in its next request and the classifier sees the same guidance",
  async (t) => {
    const { base, dir, judgeInput, launch, owner, sdk, sessionFile, work } = await startChild(
      t,
      "Implement feature in src/allowed.ts",
      { judge: "overseer-choice-fixture/choice-only" },
    );

    const escPath = path.join(dir, "escalation.json");
    await until(() => fs.existsSync(escPath), "escalation.json written at agent_before_settle");
    const esc = read(escPath, escalationSchema);
    assert.ok(esc !== undefined);
    assert.equal(esc.kind, "scope_violation");
    assert.deepEqual(esc.changedFiles, ["README.md"]);
    t.after(() => release(owner, `escalation:${esc.id}`));

    const guidance = "REVERT_README and replace x with the greeting in src/allowed.ts.";
    enqueue(base, launch, { action: "steer", prompt: guidance });

    await until(() => {
      const active = read(escPath, escalationSchema);
      return active !== undefined && active.id !== esc.id;
    }, "choice-only result paused for review");
    const paused = read(escPath, escalationSchema);
    assert.ok(paused);
    t.after(() => release(owner, `escalation:${paused.id}`));
    const journal = sdk.SessionManager.open(sessionFile).getBranch();
    const correction = journal.filter(
      (entry) => entry.type === "custom_message" && entry.customType === "overseer-correction",
    );
    assert.equal(correction.length, 1);
    assert.ok(correction[0]?.type === "custom_message");
    assert.equal(correction[0].content, guidance);
    const assistant = journal.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
        : [],
    );
    assert.deepEqual(assistant, ["DRIFTED", "REVERTED"], "no uncorrected request before the judge");
    const input: unknown = JSON.parse(fs.readFileSync(judgeInput, "utf8"));
    assert.partialDeepStrictEqual(input, {
      state: {
        taskPrompt: launch.prompt,
        taskGuidance: [guidance],
        changedFiles: ["src/allowed.ts"],
      },
      questions: { verdict: { type: "choice" } },
    });
    const notice = notifications({ sessionManager: sdk.SessionManager.inMemory() }, base, owner)
      .notices[0]?.message.content;
    assert.ok(typeof notice === "string");
    assert.match(notice, /\[Overseer escalation #2 - review needed\]/u);
    assert.match(notice, /did not identify a specific hunk or rule/u);
    assert.ok(notice.includes(guidance));
    assert.match(notice, /^\+export const greeting = 'hi';$/mu);
    assert.match(notice, /Earlier pauses answered with steering: 1\./u);
    assert.doesNotMatch(notice, /prefer/u);
    assert.doesNotMatch(notice, /scope_violation|0\.99/u);
    resolveActiveEscalation(base, launch, "approved");

    const resultPath = path.join(dir, "result.json");
    await until(() => fs.existsSync(resultPath), "result.json written after steer");
    const result = read(resultPath, resultSchema);
    assert.ok(result !== undefined);
    assert.equal(result.status, "completed");
    // The child reverted the README edit. The other session's commit is not this run's change.
    assert.deepEqual(result.changedFiles, ["src/allowed.ts"]);
    assert.equal(
      execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: work, encoding: "utf8" }),
      "other session\n",
    );

    assert.equal(
      fs.readFileSync(sessionFile, "utf8").includes("overseer-sentinel"),
      false,
      "a correction needs no generic resume reminder",
    );
  },
);

nodeTest(
  "real Actor reviews mixed tool outcomes and recognizes repeated failed calls",
  async (t) => {
    const { base, dir, launch, owner, sdk, sessionFile } = await startChild(t, "Check screenshot");
    const escPath = path.join(dir, "escalation.json");
    const parent = { sessionManager: sdk.SessionManager.inMemory() };

    async function review(lastCall: string) {
      await until(() => fs.existsSync(escPath), `pause after ${lastCall}`);
      const escalation = read(escPath, escalationSchema);
      assert.ok(escalation);
      t.after(() => release(owner, `escalation:${escalation.id}`));
      const [notice] = notifications(parent, base, owner).notices;
      const content = notice?.message.content;
      assert.ok(typeof content === "string");
      // The result has already been finalized and journaled when the child pauses.
      const result = sdk.SessionManager.open(sessionFile).getBranch().at(-1);
      assert.ok(result?.type === "message" && result.message.role === "toolResult");
      assert.equal(result.message.toolCallId, lastCall);
      return { escalation, content };
    }

    const first = await review("check-assertion");
    assert.equal(first.escalation.strikes, 1);
    assert.match(first.content, /3 consecutive turns reported tool errors/u);
    assert.match(first.content, /bash \(check-browser\): failed/u);
    assert.match(first.content, /read \(check-read\): succeeded; bash \(check-selector\): failed/u);
    assert.match(first.content, /bash \(check-assertion\): failed/u);
    assert.doesNotMatch(first.content, /no progress|clean progress|same tool and arguments/u);
    assert.doesNotMatch(JSON.stringify(first.escalation), /private-tool-output|private-arg/u);
    resolveActiveEscalation(base, launch, "approved");
    await until(() => !fs.existsSync(escPath), "first pause cleared");

    const second = await review("retry-three");
    assert.equal(second.escalation.strikes, 2);
    assert.match(second.content, /read \(retry-one\): failed/u);
    assert.match(
      second.content,
      /read \(retry-two\): failed \(same tool and arguments as retry-one\)/u,
    );
    assert.match(
      second.content,
      /read \(retry-three\): failed \(same tool and arguments as retry-one\)/u,
    );
    assert.match(second.content, /action="stop"/u);
    assert.doesNotMatch(second.content, /private-tool-output|private-arg|prefer/u);
    resolveActiveEscalation(base, launch, "approved");
    const resultPath = path.join(dir, "result.json");
    await until(() => fs.existsSync(resultPath), "child finished after the second review");
    assert.equal(read(resultPath, resultSchema)?.status, "completed");
  },
);

for (const scenario of [
  "correction at turn_end",
  "approval at turn_end",
  "stop at settle",
] as const) {
  nodeTest(`real Actor: ${scenario}`, async (t) => {
    const earlier = "Keep x instead of replacing it. Only update its value.";
    const correction = "REVERT_README and replace x with the greeting in src/allowed.ts.";
    const { base, dir, judgeInput, launch, sdk, sessionFile, toolGate, work } = await startChild(
      t,
      "Implement feature in src/allowed.ts",
      {
        holdBash: scenario !== "stop at settle",
        ...(scenario === "correction at turn_end"
          ? { judge: "overseer-choice-fixture/choice-only" }
          : {}),
      },
    );
    if (scenario === "correction at turn_end") {
      await until(() => fs.existsSync(`${toolGate}.ready`), "bash result at the first turn");
      const guidance = enqueue(base, launch, { action: "steer", prompt: earlier });
      const admission = path.join(conversation(base, launch), "admissions", `${guidance}.json`);
      await until(
        () => read(admission, admissionSchema)?.state === "accepted",
        "earlier guidance accepted by the active actor",
      );
    }
    if (scenario !== "stop at settle") {
      fs.writeFileSync(toolGate, "");
    }
    const journal = () => fs.readFileSync(sessionFile, "utf8");
    const escPath = path.join(dir, "escalation.json");
    await until(
      () => fs.existsSync(escPath) || journal().includes("UNSTEERED"),
      "escalation.json for the drifted run",
    );
    assert.equal(
      journal().includes("UNSTEERED"),
      false,
      "ordinary guidance must not release a pause",
    );
    const esc = read(escPath, escalationSchema);
    assert.equal(esc?.kind, "scope_violation");
    assert.deepEqual(esc.changedFiles, ["README.md"]);

    const resultPath = path.join(dir, "result.json");
    switch (scenario) {
      case "stop at settle":
        stopRun(base, launch, undefined, (error) => assert.fail(error));
        await until(() => fs.existsSync(resultPath), "paused stop saves the native result");
        assert.equal(read(resultPath, resultSchema)?.status, "stopped");
        assert.match(journal(), /DRIFTED/u);
        assert.doesNotMatch(journal(), /REVERTED|UNSTEERED/u, "stop does not start a request");
        assert.equal(fs.existsSync(escPath), false, "stopping removes the live pause");
        break;
      case "approval at turn_end": {
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
        await until(() => fs.existsSync(resultPath), "approval resumes the native run");
        const result = read(resultPath, resultSchema);
        assert.equal(result?.status, "completed");
        assert.deepEqual(result.changedFiles, ["README.md"]);
        assert.match(journal(), /UNSTEERED/u, "a model request ran after approval");
        assert.doesNotMatch(journal(), /REVERT_README/u, "the summary never enters child context");
        break;
      }
      case "correction at turn_end": {
        enqueue(base, launch, { action: "steer", prompt: correction });
        await until(
          () => /REVERTED|UNSTEERED/u.test(journal()),
          "first model response after the pause",
        );
        assert.equal(
          journal().includes("UNSTEERED"),
          false,
          "the next request sees the correction",
        );
        await until(() => {
          const next = read(escPath, escalationSchema);
          return next !== undefined && next.id !== esc.id;
        }, "subsequent classifier review published");
        const classifier = record(record(JSON.parse(fs.readFileSync(judgeInput, "utf8"))).state);
        const model: unknown = JSON.parse(fs.readFileSync(`${judgeInput}.model`, "utf8"));
        const messages = sdk.SessionManager.open(sessionFile)
          .getBranch()
          .flatMap((entry) => {
            if (entry.type === "custom_message" && entry.customType === "overseer-correction") {
              return [entry.content];
            }
            if (entry.type === "message" && entry.message.role === "user") {
              const { content } = entry.message;
              return typeof content === "string"
                ? [content]
                : content.flatMap((block) => (block.type === "text" ? [block.text] : []));
            }
            return [];
          })
          .filter((text) => text === earlier || text === correction);
        assert.deepEqual(
          {
            model,
            journal: messages,
            classifier: classifier.taskGuidance,
            latest: read(escPath, escalationSchema)?.classifierReview?.instruction,
            workerEdit: fs.readFileSync(path.join(work, "src", "allowed.ts"), "utf8"),
          },
          {
            model: [earlier, correction],
            journal: [earlier, correction],
            classifier: [earlier, correction],
            latest: correction,
            workerEdit: "export const greeting = 'hi';\n",
          },
        );
        resolveActiveEscalation(base, launch, "approved");
        await until(() => fs.existsSync(resultPath), "result.json written after steer");
        const result = read(resultPath, resultSchema);
        assert.equal(result?.status, "completed");
        assert.deepEqual(result.changedFiles, ["src/allowed.ts"]);
        assert.equal(journal().match(/REVERT_README/gu)?.length, 1, "published once");
        break;
      }
    }
  });
}
