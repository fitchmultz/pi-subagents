import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe as nodeDescribe, it as nodeIt, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import {
  escalationResolutionSchema,
  escalationSchema,
  type Escalation,
  type Launch,
} from "../../src/agent/contracts.ts";
import { notifications } from "../../src/agent/notifications.ts";
import {
  captureSnapshot,
  diffSnapshots,
  UNREADABLE_DIFF_MARKER,
} from "../../src/agent/overseer-diff.ts";
import {
  checkpointEvidenceLines,
  checkpointKindLabel,
  inspectJudgeCheckpoints,
  judgeUnavailable,
  readJudgeCheckpoints,
} from "../../src/agent/overseer-evidence.ts";
import { readEscalation, resolveActiveEscalation } from "../../src/agent/overseer-pause.ts";
import {
  evaluateLiveSkeptic,
  validateGroundedFindings,
  type SkepticModelRegistry,
} from "../../src/agent/overseer-skeptic.ts";
import { OverseerSentinel, readOverseerNotes } from "../../src/agent/overseer-sentinel.ts";
import {
  captureOwnerContext,
  OverseerController,
  splitModelSpec,
  writeLiveOverseer,
} from "../../src/agent/overseer.ts";
import { read, runDirectory } from "../../src/agent/storage.ts";
import { createNativeSessionFixture } from "../support/native-session.ts";

function initGitRepo(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-v2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function makeModel(provider: string, id: string, reasoning = true): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "http://127.0.0.1",
    reasoning,
    input: ["text"],
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
}

function fakeAssistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
  };
}

function makeLaunch(base: string, cwd: string, overrides: Partial<Launch> = {}): Launch {
  const id = overrides.id ?? "run-1";
  const dir = runDirectory(base, id);
  fs.mkdirSync(dir, { recursive: true });
  return {
    version: 1,
    id,
    rootId: id,
    owner: "owner-1",
    cwd,
    agentDir: path.join(base, "agent-dir"),
    sdk: "/tmp/sdk",
    entry: "/tmp/entry.js",
    sessionFile: path.join(dir, "session.jsonl"),
    sessionId: "sess-1",
    prompt: "Fix recovery checkpoint fallback",
    context: "fresh",
    provider: "google",
    model: "gemini-4-neon",
    thinking: "low",
    trusted: true,
    overseer: { enabled: true, judge: "auto" },
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeStreamRegistry(
  models: readonly Model<Api>[],
  responder: (
    model: Model<Api>,
    userPrompt: string,
    signal?: AbortSignal,
  ) => Promise<AssistantMessage>,
): SkepticModelRegistry {
  return {
    getAvailable: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    streamSimple: (model, context, options) => {
      const user = context.messages[0];
      const text = typeof user?.content === "string" ? user.content : "";
      const promise = responder(model, text, options?.signal);
      return { result: () => promise };
    },
  };
}

nodeDescribe("overseer-diff", () => {
  nodeIt(
    "tracks tracked and untracked changes across a single watermark without mutating git index",
    (t) => {
      const repo = initGitRepo(t);
      const before = captureSnapshot(repo, []);
      assert.equal(before.isGit, true);
      assert.ok(before.tree !== undefined);

      fs.writeFileSync(
        path.join(repo, "src", "app.ts"),
        "export const a = 2;\nexport const b = 3;\n",
      );
      fs.writeFileSync(path.join(repo, "src", "extra.ts"), "export const extra = true;\n");

      const after = captureSnapshot(repo, []);
      assert.ok(after.tree !== undefined);
      const delta = diffSnapshots(repo, before, after, 10_000);
      assert.deepEqual(delta.files, ["src/app.ts", "src/extra.ts"]);
      assert.ok(delta.diff.includes("+export const b = 3;"));
      assert.ok(delta.diff.includes("+export const extra = true;"));
      assert.equal(delta.lineCount, 4);
      assert.equal(delta.diffCommand, undefined);

      const status = execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" });
      assert.match(status, /\?\? src\/extra\.ts/u);

      const cut = diffSnapshots(repo, before, after, 10);
      assert.equal(cut.diffCommand, `git diff ${before.tree} ${after.tree}`);

      const same = diffSnapshots(repo, after, after, 10_000);
      assert.deepEqual(same.files, []);
      assert.equal(same.diff, "");
    },
  );
});

nodeDescribe("overseer-skeptic grounding and fallback", () => {
  const sampleDiff = [
    "diff --git a/src/recovery.ts b/src/recovery.ts",
    "index 1111111..2222222 100644",
    "--- a/src/recovery.ts",
    "+++ b/src/recovery.ts",
    "@@ -10,4 +10,5 @@ export function buildRecovery() {",
    "-  const keep = true;",
    "+  const priorWindow = notes.primaryNotePath === undefined ? history : undefined;",
    "+  const limit = 5 * 60_000;",
    " }",
  ].join("\n");

  nodeIt("keeps grounded blocking and non-blocking findings and drops fabricated quotes", () => {
    const raw = JSON.stringify({
      action: "flag",
      findings: [
        {
          kind: "dropped_behavior",
          file: "src/recovery.ts",
          excerpt:
            "+  const priorWindow = notes.primaryNotePath === undefined ? history : undefined;",
          why: "Drops checkpoint even when notes section cannot fit.",
          blocking: true,
        },
        {
          kind: "invented_constraint",
          file: "src/recovery.ts",
          excerpt: "const limit = 5 * 60_000;",
          why: "Arbitrary 5-minute interval instead of 60 seconds.",
          blocking: false,
        },
        {
          kind: "bug",
          file: "src/recovery.ts",
          excerpt: "this line does not exist anywhere in the diff",
          why: "Hallucinated finding must be dropped.",
          blocking: true,
        },
        {
          kind: "bug",
          file: "src/other.ts",
          excerpt: "const limit = 5 * 60_000;",
          why: "Wrong file must be dropped.",
          blocking: true,
        },
      ],
    });
    const checked = validateGroundedFindings(raw, ["src/recovery.ts"], sampleDiff);
    assert.ok(checked.ok);
    assert.equal(checked.blocking.length, 1);
    const [firstBlocking] = checked.blocking;
    assert.ok(firstBlocking !== undefined);
    assert.equal(firstBlocking.file, "src/recovery.ts");
    assert.equal(
      firstBlocking.excerpt,
      "const priorWindow = notes.primaryNotePath === undefined ? history : undefined;",
    );
    assert.equal(checked.notes.length, 1);
    assert.equal(checked.notes[0]?.blocking, false);
    assert.equal(checked.droppedUngrounded, 2);
  });

  nodeIt(
    "turns an all-ungrounded flag response into an ok verdict (zero content-free pauses)",
    () => {
      const raw =
        "```json\n" +
        JSON.stringify({
          action: "flag",
          findings: [
            {
              kind: "bug",
              file: "src/recovery.ts",
              excerpt: "fabricated line",
              why: "No real hunk.",
              blocking: true,
            },
          ],
        }) +
        "\n```";
      const checked = validateGroundedFindings(raw, ["src/recovery.ts"], sampleDiff);
      assert.ok(checked.ok);
      assert.equal(checked.blocking.length, 0);
      assert.equal(checked.notes.length, 0);
      assert.equal(checked.droppedUngrounded, 1);
    },
  );

  nodeIt("falls back across auto skeptic candidates and records checkpoints on disk", async (t) => {
    const repo = initGitRepo(t);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-base-"));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const launch = makeLaunch(base, repo);

    const haiku = makeModel("cloudflare-ai-gateway", "claude-haiku-5-5", false);
    const luna = makeModel("cloudflare-ai-gateway", "gpt-6-luna", true);
    const asked: string[] = [];
    const registry = makeStreamRegistry([haiku, luna], async (model) => {
      asked.push(`${model.provider}/${model.id}`);
      if (model.id === "claude-haiku-5-5") {
        return fakeAssistant("", "error", "rate limited");
      }
      return fakeAssistant(
        JSON.stringify({
          action: "flag",
          findings: [
            {
              kind: "dropped_behavior",
              file: "src/recovery.ts",
              excerpt:
                "const priorWindow = notes.primaryNotePath === undefined ? history : undefined;",
              why: "Drops checkpoint before checking whether notes fit.",
              blocking: true,
            },
          ],
        }),
      );
    });

    const failed = new Set<string>();
    const outcome = await evaluateLiveSkeptic(base, launch, {
      modelRegistry: registry,
      judgeSpec: "auto",
      ownerContext: "Never drop both checkpoint and notes.",
      taskPrompt: launch.prompt,
      guidance: [],
      changedFiles: ["src/recovery.ts"],
      diff: sampleDiff,
      failed,
      signal: undefined,
    });
    assert.equal(outcome.kind, "verdict");
    assert.deepEqual(asked, [
      "cloudflare-ai-gateway/claude-haiku-5-5",
      "cloudflare-ai-gateway/gpt-6-luna",
    ]);
    assert.equal(outcome.verdict.model, "cloudflare-ai-gateway/gpt-6-luna:medium");
    assert.equal(outcome.verdict.blocking.length, 1);
    assert.equal(outcome.checkpoint.outcome, "flagged");
    assert.equal(outcome.checkpoint.failed?.length, 1);
    assert.ok(failed.has("cloudflare-ai-gateway/claude-haiku-5-5"));
  });

  nodeIt(
    "aborts an in-flight skeptic request when overseer judge is toggled off live",
    async (t) => {
      const repo = initGitRepo(t);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-abort-"));
      t.after(() => fs.rmSync(base, { recursive: true, force: true }));
      const launch = makeLaunch(base, repo);
      writeLiveOverseer(base, { enabled: true, judge: "auto" });

      const haiku = makeModel("cloudflare-ai-gateway", "claude-haiku-5-5", false);
      let aborted = false;
      const registry = makeStreamRegistry([haiku], (_model, _prompt, signal) => {
        return new Promise<AssistantMessage>((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve(fakeAssistant("", "aborted"));
          });
          setTimeout(() => {
            writeLiveOverseer(base, { enabled: true, judge: "off" });
          }, 30);
        });
      });

      const outcome = await evaluateLiveSkeptic(base, launch, {
        modelRegistry: registry,
        judgeSpec: "auto",
        ownerContext: undefined,
        taskPrompt: launch.prompt,
        guidance: [],
        changedFiles: ["src/recovery.ts"],
        diff: sampleDiff,
        failed: new Set(),
        signal: undefined,
      });
      assert.equal(aborted, true);
      assert.equal(outcome.kind, "disabled");
    },
  );

  nodeIt(
    "validates report_findings tool calls via pi-ai and sends the full diff without client-side slicing",
    async (t) => {
      const repo = initGitRepo(t);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-tool-"));
      t.after(() => fs.rmSync(base, { recursive: true, force: true }));
      const launch = makeLaunch(base, repo);

      const model = makeModel("cloudflare-ai-gateway", "claude-haiku-5-5", false);
      let capturedPrompt = "";
      const tailMarker = "+export const tailSentinel = true;";
      const bigDiff = `${sampleDiff}\n+${"x".repeat(30_000)}\n${tailMarker}\n`;
      const registry = makeStreamRegistry([model], async (_model, prompt) => {
        capturedPrompt = prompt;
        return {
          ...fakeAssistant(""),
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "report_findings",
              arguments: {
                action: "flag",
                findings: [
                  {
                    kind: "dropped_behavior",
                    file: "src/recovery.ts",
                    excerpt:
                      "const priorWindow = notes.primaryNotePath === undefined ? history : undefined;",
                    why: "Drops checkpoint unconditionally.",
                    blocking: true,
                  },
                ],
              },
            },
          ],
        };
      });

      const outcome = await evaluateLiveSkeptic(base, launch, {
        modelRegistry: registry,
        judgeSpec: "auto",
        ownerContext: undefined,
        taskPrompt: launch.prompt,
        guidance: [],
        changedFiles: ["src/recovery.ts"],
        diff: bigDiff,
        failed: new Set(),
        signal: undefined,
      });
      assert.equal(outcome.kind, "verdict");
      assert.equal(outcome.verdict.blocking.length, 1);
      assert.ok(capturedPrompt.includes(tailMarker));
    },
  );
});

nodeDescribe("overseer controller & owner context", () => {
  nodeIt(
    "does not require a contract when overseer is enabled and captures recent owner messages",
    async (t) => {
      assert.deepEqual(splitModelSpec("cloudflare-ai-gateway/gpt-6-luna:medium"), {
        defaultModel: "cloudflare-ai-gateway/gpt-6-luna",
        defaultThinking: "medium",
      });
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-ctrl-"));
      let controller: OverseerController | undefined;
      const native = await createNativeSessionFixture({
        cwd: root,
        agentDir: root,
        configure: (pi) => {
          controller = new OverseerController(pi);
          controller.register();
        },
      });
      t.after(async () => {
        await native.dispose();
        fs.rmSync(root, { recursive: true, force: true });
      });

      const command = native.extensions[0]?.commands.get("overseer");
      assert.ok(command !== undefined && controller !== undefined);
      await command.handler("on", native.session.extensionRunner.createCommandContext());
      const prepared = controller.prepareDelegation({ prompt: "Build feature X" });
      assert.deepEqual(prepared, { overseer: { enabled: true, judge: "auto" } });

      const ownerContext = captureOwnerContext({
        getBranch: () =>
          Array.from({ length: 6 }, (_, i) => ({
            type: "message",
            id: `u${i + 1}`,
            parentId: i === 0 ? null : `u${i}`,
            timestamp: "2026-11-23T00:00:00Z",
            message: {
              role: "user",
              content:
                i === 5
                  ? [{ type: "text", text: `Rule 6: ${"z".repeat(3_000)}` }]
                  : `Rule ${i + 1}: keep earlier owner instruction`,
              timestamp: i + 1,
            },
          })),
      });
      assert.ok(ownerContext !== undefined);
      assert.match(ownerContext, /Rule 1: keep earlier owner instruction/u);
      assert.match(ownerContext, /Rule 6: zzz/u);
      assert.ok(ownerContext.length > 3_000);
    },
  );
});

async function waitForEscalation(escFile: string): Promise<Escalation> {
  for (let i = 0; i < 50; i++) {
    const esc = read(escFile, escalationSchema);
    if (esc !== undefined) {
      return esc;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for escalation at ${escFile}`);
}

const emptyBoundaryContext = {
  pendingMessages: [],
  contextEntries: [],
  contextMessages: [],
  llmMessages: [],
  canContinue: false,
};

function makeTurnEvent(toolName: string): TurnEndEvent {
  return {
    type: "turn_end",
    turnIndex: 0,
    message: fakeAssistant("ran tool"),
    messageEntryId: "m1",
    toolResultEntryIds: ["tr1"],
    toolResults: [
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName,
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 1,
      },
    ],
    entries: [],
    continue: false,
    outcome: "completed",
    context: emptyBoundaryContext,
  };
}

const settleEvent = {
  type: "agent_before_settle" as const,
  outcome: "completed" as const,
  entries: [],
  continue: false,
  context: emptyBoundaryContext,
};

nodeDescribe("overseer sentinel checkpoints", () => {
  nodeIt(
    "pauses once for early shape check on substantive edits, skips final_diff when unchanged, and publishes non-blocking notes",
    async (t) => {
      const repo = initGitRepo(t);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-sent-"));
      t.after(() => fs.rmSync(base, { recursive: true, force: true }));
      const launch = makeLaunch(base, repo, { overseer: { enabled: true, judge: "auto" } });
      const corrections: unknown[] = [];
      let stopping = false;
      t.after(() => {
        stopping = true;
      });
      const sentinel = new OverseerSentinel({
        base,
        activeLaunch: () => launch,
        activeRunBaseline: () => new Set<string>(),
        isStopping: () => stopping,
        queueCorrections: (cmds) => {
          corrections.push(...cmds);
        },
      });
      const native = await createNativeSessionFixture({
        cwd: repo,
        agentDir: base,
        configure: (pi) => {
          sentinel.attach(pi);
        },
      });
      t.after(async () => {
        await native.dispose();
      });

      const haiku = makeModel("cloudflare-ai-gateway", "claude-haiku-5-5", false);
      const streamReg = makeStreamRegistry([haiku], async () =>
        fakeAssistant(
          JSON.stringify({
            action: "flag",
            findings: [
              {
                kind: "invented_constraint",
                file: "src/follow.ts",
                excerpt: "export const extraTimeout = 9999;",
                why: "Unneeded timeout constant.",
                blocking: false,
              },
            ],
          }),
        ),
      );
      Object.assign(native.context.modelRegistry, streamReg);

      const ext = native.extensions[0];
      const turnEnd = ext?.handlers.get("turn_end")?.[0];
      const beforeSettle = ext?.handlers.get("agent_before_settle")?.[0];
      assert.ok(turnEnd !== undefined && beforeSettle !== undefined);

      // Edit 2 files -> triggers early shape_check pause.
      fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const a = 10;\n");
      fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 20;\n");

      const shapePromise = Promise.resolve(turnEnd(makeTurnEvent("write"), native.context));
      const escFile = path.join(runDirectory(base, launch.id), "escalation.json");
      const esc = await waitForEscalation(escFile);
      assert.equal(esc.kind, "shape_check");
      assert.equal(checkpointKindLabel(esc), "early shape check");
      assert.equal(checkpointEvidenceLines(esc)[0]?.includes("Early shape check"), true);

      resolveActiveEscalation(base, launch, "approved");
      await shapePromise;
      assert.equal(
        read(
          path.join(runDirectory(base, launch.id), "escalation-resolution.json"),
          escalationResolutionSchema,
        )?.verdict,
        "approved",
      );

      // No new changes -> agent_before_settle does not double-pause!
      assert.equal(await beforeSettle(settleEvent, native.context), undefined);

      // New change + final settle -> runs skeptic (emits non-blocking note) and pauses for final_diff!
      fs.writeFileSync(path.join(repo, "src", "follow.ts"), "export const extraTimeout = 9999;\n");
      const finalPromise = Promise.resolve(beforeSettle(settleEvent, native.context));
      const finalEsc = await waitForEscalation(escFile);
      assert.equal(finalEsc.kind, "final_diff");
      assert.equal(finalEsc.since, "checkpoint");
      assert.deepEqual(finalEsc.changedFiles, ["src/follow.ts"]);

      const notes = readOverseerNotes(base, launch.id);
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.findings[0]?.file, "src/follow.ts");

      resolveActiveEscalation(base, launch, "approved", {
        id: "cmd-steer-1",
        prompt: "Remove extraTimeout",
      });
      assert.deepEqual(await finalPromise, { continue: true });
      assert.equal(corrections.length, 1);

      assert.equal(readJudgeCheckpoints(base, launch.id).length, 1);
      assert.equal(judgeUnavailable(base, launch.id), undefined);
      assert.equal(
        inspectJudgeCheckpoints(base, launch.id, (n) => String(n)).lines[0]?.includes(
          "Overseer checkpoints",
        ),
        true,
      );
    },
  );

  nodeIt("skips shape_check and final_diff for readOnly runs", async (t) => {
    const repo = initGitRepo(t);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-ro-"));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const launch = makeLaunch(base, repo, { readOnly: true });
    const corrections: unknown[] = [];
    const sentinel = new OverseerSentinel({
      base,
      activeLaunch: () => launch,
      activeRunBaseline: () => new Set<string>(),
      isStopping: () => false,
      queueCorrections: (cmds) => {
        corrections.push(...cmds);
      },
    });
    const native = await createNativeSessionFixture({
      cwd: repo,
      agentDir: base,
      configure: (pi) => {
        sentinel.attach(pi);
      },
    });
    t.after(async () => {
      await native.dispose();
    });

    const ext = native.extensions[0];
    const turnEnd = ext?.handlers.get("turn_end")?.[0];
    const beforeSettle = ext?.handlers.get("agent_before_settle")?.[0];
    assert.ok(turnEnd !== undefined && beforeSettle !== undefined);

    fs.writeFileSync(path.join(repo, "src", "app.ts"), "changed\n");
    fs.writeFileSync(path.join(repo, "src", "b.ts"), "changed\n");

    await turnEnd(makeTurnEvent("bash"), native.context);
    assert.equal(await beforeSettle(settleEvent, native.context), undefined);
    assert.equal(corrections.length, 0);
    assert.equal(fs.existsSync(path.join(runDirectory(base, launch.id), "escalation.json")), false);
  });

  nodeIt(
    "fails closed when a snapshot tree is pruned and recovers once the parent approves",
    async (t) => {
      const repo = initGitRepo(t);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-prune-"));
      t.after(() => fs.rmSync(base, { recursive: true, force: true }));
      // Dirty working tree before session_start so baseline write-tree creates an unreferenced tree object.
      fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const a = 2;\n");
      const launch = makeLaunch(base, repo, { overseer: { enabled: true, judge: "off" } });
      let stopping = false;
      t.after(() => {
        stopping = true;
      });
      const sentinel = new OverseerSentinel({
        base,
        activeLaunch: () => launch,
        activeRunBaseline: () => new Set<string>(),
        isStopping: () => stopping,
        queueCorrections: () => {
          throw new Error("no corrections expected");
        },
      });
      const native = await createNativeSessionFixture({
        cwd: repo,
        agentDir: base,
        configure: (pi) => {
          sentinel.attach(pi);
        },
      });
      t.after(async () => {
        await native.dispose();
      });

      const beforeSettle = native.extensions[0]?.handlers.get("agent_before_settle")?.[0];
      assert.ok(beforeSettle !== undefined);

      // Edit file and prune the unreferenced baseline tree object written at session_start.
      fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const a = 42;\n");
      execFileSync("git", ["prune", "--expire=now"], { cwd: repo });

      const settlePromise = Promise.resolve(beforeSettle(settleEvent, native.context));
      const escFile = path.join(runDirectory(base, launch.id), "escalation.json");
      const esc = await waitForEscalation(escFile);
      assert.equal(esc.kind, "final_diff");
      assert.deepEqual(esc.changedFiles, [UNREADABLE_DIFF_MARKER]);
      assert.match(esc.summary, /diff is unavailable/u);

      resolveActiveEscalation(base, launch, "approved");
      assert.equal(await settlePromise, undefined);
      // After approval advances lastSeen to the fresh readable tree, an unchanged settle does not pause again.
      assert.equal(await beforeSettle(settleEvent, native.context), undefined);
    },
  );

  nodeIt(
    "recovers after a transient unreadable captureSnapshot without poisoning lastSeen",
    async (t) => {
      const repo = initGitRepo(t);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-transient-"));
      t.after(() => fs.rmSync(base, { recursive: true, force: true }));
      const launch = makeLaunch(base, repo, { overseer: { enabled: true, judge: "off" } });
      let stopping = false;
      t.after(() => {
        stopping = true;
      });
      const sentinel = new OverseerSentinel({
        base,
        activeLaunch: () => launch,
        activeRunBaseline: () => new Set<string>(),
        isStopping: () => stopping,
        queueCorrections: () => {
          throw new Error("no corrections expected");
        },
      });
      const native = await createNativeSessionFixture({
        cwd: repo,
        agentDir: base,
        configure: (pi) => {
          sentinel.attach(pi);
        },
      });
      t.after(async () => {
        await native.dispose();
      });

      const beforeSettle = native.extensions[0]?.handlers.get("agent_before_settle")?.[0];
      assert.ok(beforeSettle !== undefined);

      // Force a single transient write-tree failure via GIT_OBJECT_DIRECTORY pointing at a file.
      const blocker = path.join(base, "not-a-dir");
      fs.writeFileSync(blocker, "block");
      const prevObjDir = process.env.GIT_OBJECT_DIRECTORY;
      process.env.GIT_OBJECT_DIRECTORY = blocker;
      t.after(() => {
        if (prevObjDir === undefined) {
          delete process.env.GIT_OBJECT_DIRECTORY;
        } else {
          process.env.GIT_OBJECT_DIRECTORY = prevObjDir;
        }
      });

      fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const a = 99;\n");
      const settlePromise = Promise.resolve(beforeSettle(settleEvent, native.context));
      const escFile = path.join(runDirectory(base, launch.id), "escalation.json");
      const esc = await waitForEscalation(escFile);
      assert.equal(esc.kind, "final_diff");
      assert.deepEqual(esc.changedFiles, [UNREADABLE_DIFF_MARKER]);

      // Restore git before parent approves; applyAnswer re-captures a readable watermark.
      if (prevObjDir === undefined) {
        delete process.env.GIT_OBJECT_DIRECTORY;
      } else {
        process.env.GIT_OBJECT_DIRECTORY = prevObjDir;
      }
      resolveActiveEscalation(base, launch, "approved");
      assert.equal(await settlePromise, undefined);
      assert.equal(await beforeSettle(settleEvent, native.context), undefined);
    },
  );

  nodeIt(
    "normalizes legacy pre-V2 escalation payloads without suppressing structural pauses when judge is off",
    async (t) => {
      const repo = initGitRepo(t);
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overseer-legacy-esc-"));
      t.after(() => fs.rmSync(base, { recursive: true, force: true }));
      const launch = makeLaunch(base, repo, { overseer: { enabled: true, judge: "off" } });
      const dir = runDirectory(base, launch.id);
      fs.writeFileSync(path.join(dir, "launch.json"), JSON.stringify(launch));
      const file = path.join(dir, "escalation.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          id: "esc-legacy-1",
          runId: launch.id,
          owner: launch.owner,
          at: 123,
          strikes: 2,
          kind: "scope_violation",
          summary: "Edited README.md outside scope",
          changedFiles: ["README.md"],
          diffExcerpt: "+change",
          diffDigest: "abc123",
          since: "approval",
        }),
      );
      const parsed = readEscalation(file);
      assert.ok(parsed !== undefined);
      assert.equal(parsed.pauseNumber, 2);
      assert.equal(parsed.kind, "final_diff");
      assert.equal(parsed.since, "checkpoint");
      assert.deepEqual(parsed.changedFiles, ["README.md"]);

      const native = await createNativeSessionFixture({ cwd: repo, agentDir: base });
      t.after(async () => {
        await native.dispose();
      });
      const rec = notifications(native.context, base, launch.owner);
      assert.equal(rec.notices.length, 1);
      assert.equal(rec.notices[0]?.message.customType, "agent-escalation");
    },
  );
});
