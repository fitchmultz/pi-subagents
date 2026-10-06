import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import * as records from "../../src/runs/shared/run-records.ts";
import {
  getRunMetadataDir,
  listSupervisorQuestions,
  saveQuestionAnswer,
  questionProcessAlive,
} from "../../src/runs/shared/supervisor-questions.ts";
import { loadRunsForAgent } from "../../src/runs/shared/run-history.ts";
import {
  RESULTS_DIR,
  type SubagentState,
  type SubagentExecutionResult,
} from "../../src/shared/types.ts";
import {
  createEventBus,
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";

import {
  assertDefined,
  record,
  readJson,
  json,
  text,
  textAt,
  array,
  numberValue,
} from "../support/assertions.ts";
import { createSubagentState, readResult } from "../support/background-fixtures.ts";
import { nativeSdkRoot, nativeCli } from "../support/native-sdk.ts";
import { parseAsyncStatus } from "../../src/runs/background/run-schemas.ts";

const repo = path.resolve(".");
const sdkRoot = nativeSdkRoot(process.env.PI_INTERCOM_TEST_SDK);

describe("unified owner result retention through actual router", () => {
  const mock = createMockPi();
  let cwd: string;
  let runFiles: string;
  let state: SubagentState;
  before(() => mock.install());
  after(() => mock.uninstall());
  beforeEach(() => {
    mock.reset();
    cwd = createTempDir("owned-retention-");
    runFiles = createTempDir("owned-retention-state-");
    state = createSubagentState(cwd);
  });
  afterEach(() => {
    assertDefined(state.ownedRuns);
    for (const run of state.ownedRuns.values()) {
      removeTempDir(getRunMetadataDir(run.runId));
      fs.rmSync(path.join(RESULTS_DIR, `${run.runId}.json`), { force: true });
    }
    removeTempDir(cwd);
    removeTempDir(runFiles);
  });
  function executor(agent = makeAgent("worker")) {
    return createSubagentExecutor({
      pi: { events: createEventBus(), getSessionName: () => "retention-parent" },
      state,
      config: {},
      asyncByDefault: false,
      tempArtifactsDir: path.join(runFiles, "artifacts"),
      getSubagentSessionRoot: () => path.join(runFiles, "sessions"),
      expandTilde: (value) => value,
      discoverAgents: () => ({ agents: [agent] }),
    });
  }
  function saved(result: { readonly details: { readonly runId?: string } }) {
    const id = result.details.runId;
    assertDefined(id);
    return readResult(path.join(getRunMetadataDir(id), "result.json"));
  }

  it("retains explicit file-only provenance, JSON payload, and artifact references", async () => {
    const output = path.join(cwd, "report.md");
    const body = "Complete findings saved in the requested file.";
    mock.onCall({ output: body, structuredOutput: { items: ["kept"] } });
    const result = await executor().execute({
      toolCallId: "file",
      params: {
        agent: "worker",
        task: "Write findings",
        output,
        outputMode: "file-only",
        maxOutput: { bytes: 40, lines: 1 },
        outputSchema: {
          type: "object",
          properties: { items: { type: "array", items: { type: "string" } } },
          required: ["items"],
        },
      },
      ctx: makeMinimalCtx(cwd),
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const child = result.details.results[0];
    assertDefined(child.outputReference);
    assertDefined(child.artifactPaths);
    assertDefined(result.details.artifacts);
    assert.equal(child.outputMode, "file-only");
    assert.equal(child.savedOutputPath, output);
    assert.equal(child.outputReference.path, output);
    assert.equal(child.finalOutput, child.outputReference.message);
    assert.equal(textAt(result.content), child.outputReference.message);
    assert.equal(child.outputReference.bytes, Buffer.byteLength(body));
    assert.equal(textAt(result.content).split("Output saved to:").length, 2);
    assert.doesNotMatch(textAt(result.content), /Complete findings/);
    assert.equal(fs.readFileSync(output, "utf8"), body);
    assert.equal(fs.readFileSync(child.artifactPaths.outputPath, "utf8"), body);
    assert.deepEqual(child.structuredOutput, { items: ["kept"] });
    assert.deepEqual(saved(result).results[0].outputReference, child.outputReference);
    assert.equal(result.details.artifacts.files[0].metadataPath, child.artifactPaths.metadataPath);
  });

  it("retains generated-output cleanup provenance", async () => {
    mock.onCall({ output: "Inline findings" });
    const result = await executor(makeAgent("worker", { output: "report.md" })).execute({
      toolCallId: "generated",
      params: { agent: "worker", task: "Review", artifacts: false },
      ctx: makeMinimalCtx(cwd),
    });
    assert.equal(result.isError, undefined);
    const child = result.details.results[0];
    assertDefined(child.outputCleanup);
    assertDefined(child.outputReference);
    assert.equal(child.outputMode, "inline");
    assert.equal(child.outputCleanup.action, "deleted");
    assert.equal(child.savedOutputPath, undefined);
    assert.match(child.outputReference.path, /requested-outputs/);
    assert.equal(fs.existsSync(child.outputReference.path), false);
    assert.equal(child.finalOutput, "Inline findings");
    assert.equal(textAt(result.content).split("Inline findings").length, 2);
  });

  it("bounds model and owner previews while the saved output reference retains the full output", async () => {
    const full = Array.from(
      { length: 400 },
      (_, index) => `Line ${index}: ${"proof ".repeat(30)}`,
    ).join("\n");
    mock.onCall({ output: full });
    const result = await executor().execute({
      toolCallId: "bounded",
      params: { agent: "worker", task: "Report", maxOutput: { bytes: 600, lines: 6 } },
      ctx: makeMinimalCtx(cwd),
    });
    assert.equal(result.isError, undefined);
    assert.match(textAt(result.content), /TRUNCATED/);
    assert.ok(textAt(result.content).length < 1200);
    assert.ok(text(result.details.results[0].finalOutput).length < 1200);
    assertDefined(result.details.run);
    const ownerResult = result.details.run.children[0].result;
    assertDefined(ownerResult);
    assert.ok(text(ownerResult.finalOutput).length < 1200);
    assertDefined(result.details.truncation);
    assert.equal(result.details.truncation.truncated, true);
    const durable = saved(result);
    assert.ok(text(durable.results[0].finalOutput).length <= 8192);
    assert.ok(text(durable.summary).length <= 8192);
    assertDefined(durable.results[0].artifactPaths);
    assertDefined(durable.results[0].artifactPaths.outputPath);
    assertDefined(result.details.results[0].artifactPaths);
    assert.equal(durable.recordVersion, 3);
    assert.equal(
      durable.results[0].artifactPaths.outputPath,
      result.details.results[0].artifactPaths.outputPath,
    );
    assert.equal(
      fs.readFileSync(durable.results[0].artifactPaths.outputPath, "utf8"),
      full.trimEnd(),
    );
  });

  for (const mode of ["parallel", "chain"] as const) {
    it(`${mode} timeout keeps configured deadline, partial output and completed siblings`, async () => {
      const clockFile = path.join(cwd, "owner-clock.json");
      const release = path.join(cwd, "release-slow");
      const previous = {
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        PI_TEST_RUNNER_CLOCK: process.env.PI_TEST_RUNNER_CLOCK,
      };
      process.env.NODE_OPTIONS = `${previous.NODE_OPTIONS ?? ""} --import=${new URL("../fixtures/runner-clock.mjs", import.meta.url).href}`;
      process.env.PI_TEST_RUNNER_CLOCK = clockFile;
      mock.onCall({ matchArgsIncludes: "Fast", output: "Completed sibling evidence" });
      mock.onCall({
        matchArgsIncludes: "Slow",
        steps: [
          { jsonl: [events.assistantMessage("Partial slow evidence")] },
          { waitForFile: release, jsonl: [events.assistantMessage("Too late")] },
        ],
      });
      const tasks = [
        { agent: "worker", task: "Fast" },
        { agent: "worker", task: "Slow" },
      ];
      const pending = executor().execute({
        toolCallId: "timeout",
        params: {
          ...(mode === "parallel" ? { tasks, concurrency: 1 } : { chain: tasks }),
          timeoutMs: 600,
        },
        ctx: makeMinimalCtx(cwd),
      });
      const waitFor = async (check: () => boolean, description: string) => {
        const deadline = Date.now() + 5_000;
        while (!check()) {
          assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
          // Observe actual owner publication before advancing its clock.
          // oxlint-disable-next-line no-await-in-loop
          await delay(5);
        }
      };
      let sequence = 0;
      const tick = async (amount: number) => {
        fs.writeFileSync(
          `${clockFile}.tmp`,
          JSON.stringify({ sequence: ++sequence, tick: amount }),
        );
        fs.renameSync(`${clockFile}.tmp`, clockFile);
        await waitFor(
          () =>
            fs.existsSync(`${clockFile}.ack`) &&
            record(readJson(`${clockFile}.ack`)).sequence === sequence,
          "owner clock acknowledgement",
        );
        return numberValue(record(readJson(`${clockFile}.ack`)).now);
      };
      let result: SubagentExecutionResult | undefined;
      try {
        await waitFor(() => mock.callCount() === 2, "both real child processes start");
        const run = state.ownedRuns?.values().next().value;
        assertDefined(run);
        const directory = getRunMetadataDir(run.runId);
        const status = () => parseAsyncStatus(readJson(path.join(directory, "status.json")));
        const initial = status();
        assertDefined(initial.startedAt);
        assertDefined(initial.timeoutAt);
        assert.equal(initial.timeoutAt - initial.startedAt, 600);
        await waitFor(
          () =>
            fs.existsSync(path.join(directory, "output-1.log")) &&
            fs
              .readFileSync(path.join(directory, "output-1.log"), "utf8")
              .includes("Partial slow evidence"),
          "owner receives partial slow output",
        );
        // Cold child startup must not race the owner deadline under suite load.
        assert.equal(await tick(599), initial.startedAt + 599);
        await waitFor(
          () => status().steps?.[1]?.recentOutput?.includes("Partial slow evidence") === true,
          "owner publishes parsed partial output",
        );
        assert.equal(status().timedOut, undefined);
        assert.equal(status().steps?.[0]?.status, "complete");
        assert.equal(await tick(1), initial.timeoutAt);
        result = await pending;
      } finally {
        try {
          try {
            if (result === undefined) {
              await tick(600);
            }
          } finally {
            fs.writeFileSync(release, "cleanup");
          }
          await pending;
        } finally {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) {
              delete process.env[key];
            } else {
              process.env[key] = value;
            }
          }
        }
      }
      assertDefined(result);
      assert.equal(result.isError, true);
      assert.match(
        textAt(result.content),
        mode === "parallel" ? /Parallel run timed out/ : /Chain timed out/,
      );
      assert.match(textAt(result.content), /Timed out after 600ms\./);
      assert.match(textAt(result.content), /Completed sibling evidence/);
      assert.match(textAt(result.content), /Partial slow evidence/);
      assert.equal(result.details.results[0].exitCode, 0);
      assert.equal(result.details.results[1].timedOut, true);
      assert.equal(result.details.results[1].error, "Timed out after 600ms.");
      assert.match(text(result.details.results[1].finalOutput), /Partial output before timeout/);
    });
  }

  it("records owner-side duration history used by subsequent planner budgets", async () => {
    const name = `planner-${path.basename(cwd)}`;
    const execute = executor(makeAgent(name));
    for (let index = 0; index < 3; index++) {
      mock.onCall({ output: "Seed finished", delay: 400 });
      // Each duration sample must finish and persist before the next planner seed.
      // oxlint-disable-next-line no-await-in-loop
      const result = await execute.execute({
        toolCallId: `seed-${index}`,
        params: { agent: name, task: `Seed ${index}`, artifacts: false },
        ctx: makeMinimalCtx(cwd),
      });
      assert.equal(result.isError, undefined);
    }
    const history = loadRunsForAgent(name);
    assert.equal(history.length, 3);
    assert.ok(history.every((entry) => entry.status === "ok" && entry.duration >= 400));
    mock.onCall({ output: "Planner finished within its historical budget", delay: 250 });
    const result = await execute.execute({
      toolCallId: "planner",
      params: { agent: name, task: "Plan", timeoutMs: 180, artifacts: false },
      ctx: makeMinimalCtx(cwd),
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.match(textAt(result.content), /Planner finished/);
    assert.equal(loadRunsForAgent(name).length, 4);
  });

  it("projects real tool progress and retains compact summaries without raw tool payloads", async (t) => {
    mock.onCall({
      steps: [
        {
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "read-1",
                    name: "read",
                    arguments: { path: "source.ts" },
                  },
                ],
                stopReason: "toolUse",
              },
            },
            events.toolStart("read", { path: "source.ts" }),
          ],
        },
        {
          delay: 500,
          jsonl: [
            events.toolResult("read", "large raw payload ".repeat(5000)),
            events.toolEnd("read"),
            { type: "message_start", message: { role: "assistant", content: [] } },
            {
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: "Working summary",
              },
            },
          ],
        },
        { delay: 500, jsonl: [events.assistantMessage("Finished compactly")] },
      ],
    });
    const pending = executor().execute({
      toolCallId: "progress",
      params: { agent: "worker", task: "Inspect", includeProgress: true },
      ctx: makeMinimalCtx(cwd),
    });
    const observed: SubagentExecutionResult[] = [];
    const settled = t.mock.fn(() => {
      // The mock's native call count observes completion without faking a receipt.
    });
    const observation = (async () => {
      while (settled.mock.callCount() === 0) {
        const run = state.ownedRuns?.values().next().value;
        if (run) {
          observed.push(records.ownedRunProgressResult(run, state));
        }
        // Progress observations remain ordered until the real execution settles.
        // oxlint-disable-next-line no-await-in-loop
        await delay(25);
      }
    })();
    const completion = pending.finally(settled);
    await Promise.allSettled([completion, observation]);
    const result = await completion;
    await observation;
    assert.ok(observed.some((update) => update.details.progress?.[0]?.currentTool === "read"));
    assert.ok(
      observed.some((update) => update.details.progress?.[0]?.streamingText === "Working summary"),
    );
    const progress = result.details.progress?.[0];
    assert.ok(
      progress,
      "includeProgress must retain owner progress in the final public executor result",
    );
    assert.equal(progress.agent, "worker");
    assert.equal(progress.task, "Inspect");
    assert.equal(progress.status, "complete");
    assert.equal(progress.toolCount, 1);
    assert.ok(progress.durationMs >= 1000);
    assertDefined(result.details.runId);
    const run = state.ownedRuns?.get(result.details.runId);
    assertDefined(run);
    const ownerProgress = records.ownedRunProgressResult(run, state);
    assert.deepEqual(result.details.progress, ownerProgress.details.progress);
    assert.equal(
      ownerProgress.details.results[0].finalOutput,
      "Finished compactly",
      "completed children keep their final output in live workflow updates",
    );
    assert.doesNotMatch(JSON.stringify(result), /large raw payload/);
    const child = result.details.results[0];
    assert.equal(child.messages, undefined);
    assert.equal(child.progress, undefined);
    assertDefined(child.progressSummary);
    assertDefined(child.toolCalls);
    assert.equal(child.progressSummary.toolCount, 1);
    assert.ok(child.progressSummary.durationMs >= 1000);
    assert.equal(child.toolCalls[0].text, "read source.ts");
    assert.ok(JSON.stringify(result).length < 80_000);
  });

  for (const includeProgress of [undefined, false]) {
    it(`keeps final results compact with includeProgress ${String(includeProgress)}`, async () => {
      mock.onCall({ output: "Compact result" });
      const result = await executor().execute({
        toolCallId: "compact",
        params: {
          agent: "worker",
          task: "Inspect",
          ...(includeProgress === undefined ? {} : { includeProgress }),
        },
        ctx: makeMinimalCtx(cwd),
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.progress, undefined);
      assert.equal(result.details.results[0].progress, undefined);
      assert.equal(result.details.results[0].messages, undefined);
      assertDefined(result.details.progressSummary);
      assert.ok(result.details.progressSummary.durationMs > 0);
    });
  }

  for (const outcome of ["success", "error", "disabled"]) {
    it(`retains explicitly requested session sharing ${outcome} in the final result`, async () => {
      const previous = {
        PATH: process.env.PATH,
        PI_DRIVER_FIXTURE: process.env.PI_DRIVER_FIXTURE,
        PI_INTERCOM_TEST_SDK: process.env.PI_INTERCOM_TEST_SDK,
      };
      const bin = path.join(cwd, "bin"),
        input = path.join(cwd, "native.json"),
        calls = path.join(cwd, "gh-calls.txt");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "pi"),
        `#!/bin/sh\nexec '${process.execPath}' '${nativeCli(sdkRoot)}' "$@"\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(bin, "gh"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = auth ]; then exit 0; fi\n${outcome === "error" ? "echo 'Fixture share failure' >&2\nexit 1" : "echo 'https://gist.github.com/fixture/local-only-fixture'"}\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        input,
        JSON.stringify({ scenario: "success", receiptPath: path.join(cwd, "receipt.json") }),
      );
      Object.assign(process.env, {
        PATH: `${bin}${path.delimiter}${previous.PATH ?? ""}`,
        PI_DRIVER_FIXTURE: input,
        PI_INTERCOM_TEST_SDK: sdkRoot,
      });
      try {
        const result = await executor(
          makeAgent("worker", {
            model: "driver-fixture/faux-1",
            extensions: [path.join(repo, "test/fixtures/native-child-attempt.mjs")],
          }),
        ).execute({
          toolCallId: "share",
          params: {
            agent: "worker",
            task: "Inspect",
            ...(outcome === "disabled" ? {} : { share: true }),
            artifacts: false,
          },
          ctx: makeMinimalCtx(cwd),
        });
        assert.equal(result.isError, undefined, JSON.stringify(result.content));
        const durable = saved(result);
        if (outcome === "success") {
          assert.equal(
            durable.shareUrl,
            "https://shittycodingagent.ai/session/?local-only-fixture",
          );
          assert.equal(result.details.shareUrl, durable.shareUrl);
          assert.equal(
            result.details.gistUrl,
            "https://gist.github.com/fixture/local-only-fixture",
          );
          assert.ok(textAt(result.content).includes(text(durable.shareUrl)));
        } else if (outcome === "error") {
          assert.match(text(durable.shareError), /Fixture share failure/);
          assert.equal(result.details.shareError, durable.shareError);
          assert.match(textAt(result.content), /Session share error:.*Fixture share failure/);
        } else {
          assert.equal(fs.existsSync(calls), false, "sharing must remain opt-in");
          assert.equal(result.details.shareUrl, undefined);
          assert.equal(result.details.gistUrl, undefined);
          assert.equal(result.details.shareError, undefined);
        }
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });
  }

  it("preserves binary worktree patch references in the model and durable result", async (t) => {
    const git = (...args: readonly string[]) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q");
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
    git("add", "tracked.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    );
    const release = path.join(cwd, "release-binary-child");
    mock.onCall({ output: "Binary change complete", waitForFile: release });
    const pending = executor().execute({
      toolCallId: "patch",
      params: {
        tasks: [{ agent: "worker", task: "Create binary" }],
        worktree: true,
        artifacts: false,
      },
      ctx: makeMinimalCtx(cwd),
    });
    const settled = t.mock.fn(() => {
      // Observe the real executor's settlement while its child waits for release.
    });
    const observation = (async () => {
      try {
        const deadline = Date.now() + 10_000;
        while (mock.callCount() === 0 && settled.mock.callCount() === 0) {
          assert.ok(Date.now() < deadline, "binary child must start");
          // The child's launch must be published before writing in its worktree.
          // oxlint-disable-next-line no-await-in-loop
          await delay(10);
        }
        assert.ok(mock.callCount() > 0, "binary child must start before executor settlement");
        const callFile = fs.readdirSync(mock.dir).find((file) => file.startsWith("call-"));
        assertDefined(callFile);
        const call = record(readJson(path.join(mock.dir, callFile)));
        fs.writeFileSync(
          path.join(text(call.cwd), "image.bin"),
          Buffer.from([0, 255, 0, 128, 1, 0]),
        );
      } finally {
        fs.writeFileSync(release, "");
      }
    })();
    const completion = pending.finally(settled);
    await Promise.allSettled([completion, observation]);
    const result = await completion;
    await observation;
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const patchDir = textAt(result.content).match(/Full patches: ([^\n]+)/)?.[1];
    assertDefined(patchDir);
    const patchFile = fs.readdirSync(patchDir).find((file) => file.endsWith(".patch"));
    assertDefined(patchFile);
    const patch = path.join(patchDir, patchFile);
    assert.match(fs.readFileSync(patch, "utf8"), /GIT binary patch/);
    assert.ok(text(saved(result).summary).includes(patchDir));
  });

  for (const scenario of [
    "blocked",
    "public-output",
    "dynamic",
    "question-initial",
    "question-review",
  ]) {
    it(`retains actual native ${scenario} acceptance through the router`, async () => {
      const previous = {
        PATH: process.env.PATH,
        PI_DRIVER_FIXTURE: process.env.PI_DRIVER_FIXTURE,
        PI_INTERCOM_TEST_SDK: process.env.PI_INTERCOM_TEST_SDK,
      };
      const bin = path.join(cwd, "bin"),
        input = path.join(cwd, "native.json");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "pi"),
        `#!/bin/sh\nexec '${process.execPath}' '${nativeCli(sdkRoot)}' "$@"\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        input,
        JSON.stringify({
          scenario: scenario === "dynamic" ? "public-output" : scenario,
          ...(scenario === "dynamic" ? { items: ["a", "b"] } : {}),
          receiptPath: path.join(cwd, "receipt.json"),
          report: {
            criteriaSatisfied: [{ id: "deliver", status: "satisfied", evidence: "fixture" }],
          },
        }),
      );
      Object.assign(process.env, {
        PATH: `${bin}${path.delimiter}${previous.PATH ?? ""}`,
        PI_DRIVER_FIXTURE: input,
        PI_INTERCOM_TEST_SDK: sdkRoot,
      });
      try {
        const launch = executor(
          makeAgent("worker", {
            model: "driver-fixture/faux-1",
            extensions: [
              path.join(repo, "test/fixtures/native-child-attempt.mjs"),
              ...(scenario.startsWith("question-") ? ["pi-intercom"] : []),
            ],
          }),
        );
        const acceptance = { criteria: [{ id: "deliver", must: "Complete fixture" }] };
        const outputSchema = {
          type: "object",
          properties: { items: { type: "array", items: { type: "string" } } },
          required: ["items"],
        };
        const result = await launch.execute({
          toolCallId: "native",
          params:
            scenario === "dynamic"
              ? {
                  chain: [
                    { agent: "worker", task: "List items", as: "items", outputSchema },
                    {
                      expand: { from: { output: "items", path: "/items" }, maxItems: 2 },
                      parallel: {
                        agent: "worker",
                        task: "Review {item}",
                        acceptance,
                        outputSchema,
                      },
                      collect: { as: "reviews" },
                      concurrency: 1,
                    },
                  ],
                }
              : {
                  agent: "worker",
                  task: "Complete fixture",
                  acceptance,
                  ...(scenario === "public-output"
                    ? {
                        output: path.join(cwd, "native-report.md"),
                        outputMode: "file-only",
                        outputSchema,
                      }
                    : {}),
                },
          ctx: makeMinimalCtx(cwd),
        });
        assert.equal(result.isError, undefined, JSON.stringify(result.content));
        if (scenario.startsWith("question-")) {
          assertDefined(result.details.wait);
          assert.equal(result.details.wait.status, "awaiting_input");
          const runId = result.details.wait.runId;
          const question = listSupervisorQuestions("session-123", runId).find(
            (entry) => entry.state === "awaiting_input",
          );
          assert.ok(question);
          const receipt = record(readJson(path.join(cwd, "receipt.json")));
          assert.equal(receipt.calls, scenario === "question-initial" ? 1 : 2);
          assert.equal(questionProcessAlive({ pid: numberValue(receipt.pid) }), true);
          assert.equal(fs.existsSync(path.join(getRunMetadataDir(runId), "result.json")), false);
          saveQuestionAnswer(question, "Proceed with the fixture.");
          const deadline = Date.now() + 10_000;
          while (!fs.existsSync(path.join(getRunMetadataDir(runId), "result.json"))) {
            assert.ok(Date.now() < deadline, "owner must complete after answer");
            // Observe the owner's actual terminal publication after answering.
            // oxlint-disable-next-line no-await-in-loop
            await delay(20);
          }
          const completed = saved({ details: { runId } });
          assert.equal(completed.success, true, JSON.stringify(completed));
          assert.equal(completed.results[0].finalOutput, "Reviewed answer");
          const finalization = completed.results[0].acceptance?.finalization;
          const processExit = completed.results[0].agentProcessExit;
          assertDefined(finalization);
          assertDefined(processExit);
          assert.equal(finalization.turns.length, 1);
          assert.equal(processExit.pid, receipt.pid);
          const terminalEvents = fs
            .readFileSync(path.join(getRunMetadataDir(runId), "events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map(json);
          assert.equal(
            terminalEvents.filter((event) => event.type === "subagent.run.completed").length,
            1,
          );
          return;
        }
        if (scenario === "dynamic") {
          assertDefined(result.details.workflowGraph);
          const expanded = result.details.workflowGraph.nodes[1].children;
          assertDefined(expanded);
          assert.deepEqual(
            expanded.map((child) => child.acceptanceStatus),
            ["checked", "checked"],
          );
          assertDefined(result.details.outputs);
          assert.equal(array(result.details.outputs.reviews.structured).length, 2);
          return;
        }
        const child = result.details.results[0];
        assertDefined(child.acceptance);
        if (scenario === "blocked") {
          assert.match(textAt(result.content), /Needs your action/);
          assert.match(textAt(result.content), /Complete Touch ID/);
          assert.equal(child.acceptance.status, "blocked");
          assert.equal(child.acceptance.finalization, undefined);
        } else {
          assertDefined(child.outputReference);
          assertDefined(child.acceptance.finalization);
          assertDefined(child.savedOutputPath);
          assert.equal(child.outputMode, "file-only");
          assert.equal(child.savedOutputPath, path.join(cwd, "native-report.md"));
          assert.equal(child.finalOutput, child.outputReference.message);
          assert.equal(
            fs.readFileSync(child.savedOutputPath, "utf8"),
            '{"items":["reviewed payload"]}',
          );
          assert.deepEqual(child.structuredOutput, { items: ["reviewed payload"] });
          assert.equal(child.acceptance.finalization.turns.length, 1);
          assert.equal(child.initialOutput, "");
          assert.equal(child.usage.turns, 2);
        }
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });
  }
});
