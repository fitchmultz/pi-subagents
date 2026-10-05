import {
  assertDefined,
  record,
  text as stringValue,
  array,
  textAt,
} from "../support/assertions.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import {
  createSubagentExecutor,
  type SubagentParamsLike,
} from "../../src/runs/foreground/subagent-executor.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { OWNED_RUN_ENTRY, restoreOwnedRuns } from "../../src/runs/shared/run-records.ts";
import { getRunMetadataDir } from "../../src/runs/shared/supervisor-questions.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  INTERCOM_DETACH_REQUEST_EVENT,
  type SubagentState,
  type SubagentExecutionResult,
  type TrackedOwnedRun,
} from "../../src/shared/types.ts";
import {
  createEventBus,
  createNativeSessionFixture,
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";

const sdkRoot =
  process.env.PI_OWNERSHIP_TEST_PACKAGE_ROOT ??
  path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
assert.equal(
  fs.realpathSync(sdkRoot),
  fs.realpathSync(
    path.dirname(
      path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
    ),
  ),
  "selected host must match the installed SDK graph",
);
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
import { createSubagentState, readResult, readStatusFile } from "../support/background-fixtures.ts";
import { readChildCall } from "../support/child-process-receipts.ts";
const nativeRoot = createTempDir("mixed-sdk-");
const native = await createNativeSessionFixture({ cwd: nativeRoot, agentDir: nativeRoot });
after(async () => {
  await native.dispose();
  removeTempDir(nativeRoot);
});
const failureReason = "MIXED_BAD: required evidence was rejected";
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    // Observe the owner publication before advancing this lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}

describe("mixed sibling host outcomes", { timeout: 90_000 }, () => {
  const mock = createMockPi();
  before(() => mock.install());
  after(() => mock.uninstall());

  for (const shape of ["parallel", "static-chain", "dynamic-chain"] as const) {
    for (const host of ["foreground", "background"] as const) {
      for (const stop of host === "background"
        ? (["interrupt"] as const)
        : (["interrupt", "detach", "detach-queued", "timeout"] as const)) {
        for (const failed of stop === "timeout" ? [true] : [true, false]) {
          it(`${host} ${shape}: ${failed ? "failed + successful" : "successful"} + ${stop}`, async () => {
            mock.reset();
            const detaching = stop.startsWith("detach");
            const aggregateFailed = failed;
            const cwd = createTempDir("mixed-siblings-");
            const release = path.join(cwd, "release-child");
            const parentFile = path.join(cwd, "parent.jsonl");
            fs.writeFileSync(
              parentFile,
              `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd, timestamp: new Date().toISOString() })}\n`,
            );
            let parent = SessionManager.open(parentFile);
            const state = {
              ...createSubagentState(cwd),
              baseCwd: cwd,
              currentSessionId: parentFile,
              asyncJobs: new Map(),
              ownedRuns: new Map<string, TrackedOwnedRun>(),
              completionSeen: new Map(),
              cleanupTimers: new Map(),
              persistOwnedRun: (run) => {
                parent.appendCustomEntry(OWNED_RUN_ENTRY, run);
              },
            } satisfies SubagentState;
            const ctx = { ...makeMinimalCtx(cwd), sessionManager: parent };
            const bus = createEventBus();
            const notifications: Record<string, unknown>[] = [];
            bus.on("subagent:result-intercom", (message) => {
              const payload = record(message);
              notifications.push(payload);
              bus.emit("subagent:result-intercom-delivery", {
                requestId: stringValue(record(message).requestId),
                delivered: true,
              });
            });
            const pi = { ...native.pi, events: bus, getSessionName: () => "mixed-parent" };
            const tracker = createAsyncJobTracker(pi, state, ASYNC_DIR);
            bus.on("subagent:async-started", tracker.handleStarted);
            bus.on("subagent:async-complete", tracker.handleComplete);
            const executor = createSubagentExecutor({
              pi,
              state,
              config: {},
              asyncByDefault: false,
              tempArtifactsDir: cwd,
              getSubagentSessionRoot: () => path.join(cwd, "sessions"),
              expandTilde: (value) => value,
              discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false })] }),
            });
            const invoke = (
              params: SubagentParamsLike,
              onUpdate?: (result: SubagentExecutionResult) => void,
            ) =>
              executor.execute({
                toolCallId: randomUUID(),
                params: params,
                signal: new AbortController().signal,
                onUpdate: onUpdate,
                ctx: ctx,
              });
            const watcher = createResultWatcher(pi, state, RESULTS_DIR);
            // One active child makes completion order deterministic; failures cannot stop the wait child.
            const tokens = [
              "MIXED_OK",
              ...(failed ? ["MIXED_BAD"] : []),
              "MIXED_WAIT",
              ...(stop === "detach" ? [] : ["MIXED_QUEUED"]),
            ];
            const prefixCount = shape === "parallel" ? 0 : 1;
            const waitIndex = prefixCount + tokens.indexOf("MIXED_WAIT");
            mock.onCall({
              matchArgsIncludes: "MIXED_SOURCE",
              output: "PREFIX_EVIDENCE",
              structuredOutput: { items: tokens },
            });
            mock.onCall({ matchArgsIncludes: "MIXED_OK", output: "SUCCESSFUL_SIBLING_EVIDENCE" });
            mock.onCall({ matchArgsIncludes: "MIXED_BAD", stderr: failureReason, exitCode: 1 });
            mock.onCall({
              matchArgsIncludes: "MIXED_WAIT",
              steps: [
                {
                  jsonl: [
                    events.toolStart(
                      detaching ? "contact_supervisor" : "bash",
                      detaching ? { reason: "need_decision" } : { command: "controlled wait" },
                    ),
                  ],
                },
                {
                  ...(detaching ? { waitForFile: release } : { delay: 20_000 }),
                  jsonl: [events.assistantMessage("DETACHED_CHILD_FINISHED")],
                },
              ],
            });
            mock.onCall({ matchArgsIncludes: "MIXED_QUEUED", output: "QUEUED_CHILD_FINISHED" });
            mock.onCall({ matchArgsIncludes: "MIXED_DOWNSTREAM", output: "DOWNSTREAM_FINISHED" });
            const tasks = tokens.map((task) => ({ agent: "worker", task, output: false as const }));
            const prefix = {
              agent: "worker",
              task: "MIXED_SOURCE",
              as: "targets",
              output: false as const,
              outputSchema: { type: "object" },
            };
            const downstream = {
              agent: "worker",
              task: "MIXED_DOWNSTREAM",
              output: false as const,
            };
            const group =
              shape === "dynamic-chain"
                ? {
                    expand: {
                      from: { output: "targets", path: "/items" },
                      maxItems: tokens.length,
                    },
                    parallel: { agent: "worker", task: "{item}", output: false as const },
                    collect: { as: "collected" },
                    concurrency: 1,
                    failFast: false,
                  }
                : {
                    parallel: tasks.map((task, index) => ({
                      ...task,
                      ...(index === 0 ? { as: "evidence" } : {}),
                    })),
                    concurrency: 1,
                    failFast: false,
                  };
            let ready = false,
              runId: string | undefined;
            let pending: ReturnType<typeof invoke> | undefined;
            try {
              pending = invoke(
                {
                  ...(shape === "parallel"
                    ? { tasks, concurrency: 1 }
                    : { chain: [prefix, group, downstream] }),
                  async: host === "background",
                  context: "fresh",
                  artifacts: false,
                  ...(stop === "timeout" ? { timeoutMs: 3_000 } : {}),
                },
                (update) => {
                  if (
                    update.details?.progress?.some(
                      (progress) =>
                        progress.currentTool === (detaching ? "contact_supervisor" : "bash"),
                    ) === true
                  ) {
                    ready = true;
                  }
                },
              );
              await waitFor(() => state.ownedRuns.size === 1, "owned run registration");
              const defined8602_0 = [...state.ownedRuns.keys()][0];
              assertDefined(defined8602_0);
              runId = defined8602_0;
              assertDefined(runId);
              const metadata = getRunMetadataDir(runId);
              await waitFor(
                () =>
                  host === "foreground"
                    ? ready
                    : fs.existsSync(path.join(metadata, "status.json")) &&
                      readStatusFile(path.join(metadata, "status.json")).steps?.[waitIndex]
                        ?.currentTool === "bash",
                "wait child after successful/failed siblings",
              );
              if (stop === "interrupt") {
                const interrupted = await invoke({ action: "interrupt", id: runId });
                assert.equal(interrupted.isError, undefined, JSON.stringify(interrupted));
              } else if (detaching) {
                bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: randomUUID() });
              }
              const response = await pending;
              if (detaching) {
                fs.writeFileSync(release, "");
              }
              const initial = structuredClone(response);
              let terminal: SubagentExecutionResult["details"] | ReturnType<typeof readResult> =
                initial.details;
              if (host === "background" || detaching) {
                await waitFor(
                  () => fs.existsSync(path.join(metadata, "result.json")),
                  "durable background result",
                );
                terminal = readResult(path.join(metadata, "result.json"));
                await waitFor(
                  () => fs.existsSync(path.join(RESULTS_DIR, `${runId}.json`)),
                  "notification file before the one-time scan",
                );
                watcher.primeExistingResults();
                await waitFor(
                  () => notifications.some((entry) => entry.runId === runId),
                  "grouped background completion",
                );
              }
              const beforeSettlement = await invoke({ action: "status", id: runId });
              parent = SessionManager.open(parentFile);
              ctx.sessionManager = parent;
              state.foregroundRuns = new Map();
              restoreOwnedRuns(state, ctx);
              const inspection = await invoke({ action: "status", id: runId });
              const calls = fs
                .readdirSync(mock.dir)
                .filter((file) => file.startsWith("call-"))
                .sort()
                .map((file) => readChildCall(path.join(mock.dir, file)));
              const receipt = {
                host,
                shape,
                stop,
                failed,
                aggregateFailed,
                initial,
                terminal,
                beforeSettlement,
                inspection,
                notifications,
                calls,
              };
              if ((process.env.PI_MIXED_SIBLING_EVIDENCE_DIR ?? "").length > 0) {
                assertDefined(process.env.PI_MIXED_SIBLING_EVIDENCE_DIR);
                fs.mkdirSync(process.env.PI_MIXED_SIBLING_EVIDENCE_DIR, { recursive: true });
                assertDefined(process.env.PI_MIXED_SIBLING_EVIDENCE_DIR);
                fs.writeFileSync(
                  path.join(
                    process.env.PI_MIXED_SIBLING_EVIDENCE_DIR,
                    `${host}-${shape}-${stop}-${failed ? "mixed" : "pure"}.json`,
                  ),
                  JSON.stringify(receipt, null, 2),
                );
              }
              const results = terminal.results;
              const executed = [
                ...(prefixCount ? ["MIXED_SOURCE"] : []),
                ...tokens.slice(0, detaching ? tokens.length : tokens.indexOf("MIXED_WAIT") + 1),
                ...(detaching && !failed && shape !== "parallel" ? ["MIXED_DOWNSTREAM"] : []),
              ];
              assert.equal(
                calls.length,
                executed.length,
                "detach continues queued work; interruption and timeout stop it",
              );
              assert.deepEqual(
                calls.map(
                  (call) =>
                    stringValue(call.expandedArgs.at(-1)).match(
                      /MIXED_(SOURCE|OK|BAD|WAIT|QUEUED|DOWNSTREAM)/,
                    )?.[0],
                ),
                executed,
              );
              assert.equal(
                results[prefixCount].finalOutput ?? record(results[prefixCount]).output,
                "SUCCESSFUL_SIBLING_EVIDENCE",
              );
              if (failed) {
                assert.equal(results[prefixCount + 1].error, failureReason);
              }
              if (stop === "interrupt") {
                assert.equal(results[waitIndex].interrupted, true);
                assert.equal(results[waitIndex + 1].interrupted, true, "queued child stays paused");
              } else if (detaching) {
                assert.equal(record(results[waitIndex]).output, "DETACHED_CHILD_FINISHED");
                if (stop === "detach-queued") {
                  assert.equal(record(results[waitIndex + 1]).output, "QUEUED_CHILD_FINISHED");
                }
              } else {
                assert.equal(results[waitIndex].timedOut, true);
              }
              if (shape === "static-chain") {
                assertDefined(terminal.outputs);
                assert.equal(terminal.outputs.evidence.text, "SUCCESSFUL_SIBLING_EVIDENCE");
              }
              if (shape === "dynamic-chain") {
                if (detaching && !failed) {
                  assertDefined(terminal.outputs);
                  assert.equal(array(terminal.outputs.collected.structured).length, tokens.length);
                } else {
                  assertDefined(terminal.outputs);
                  assert.equal(
                    terminal.outputs.collected,
                    undefined,
                    "failed or stopped collections must not publish",
                  );
                }
              }
              const defined14190_0 = inspection.details.run;
              assertDefined(defined14190_0);
              const saved = defined14190_0;
              const expectedState = aggregateFailed ? "failed" : detaching ? "completed" : "paused";
              assert.equal(saved.state, expectedState);
              if (detaching) {
                const notification = notifications.find((entry) => entry.runId === runId);
                assertDefined(notification);
                assert.equal(notification.status, expectedState);
                assertDefined(notification);
                assert.match(stringValue(notification.message), /SUCCESSFUL_SIBLING_EVIDENCE/);
                assertDefined(notification);
                assert.equal(record(array(notification.children)[waitIndex]).status, "completed");
              }
              assert.equal(saved.children[prefixCount].state, "completed");
              assert.equal(
                saved.children[prefixCount].result?.finalOutput,
                "SUCCESSFUL_SIBLING_EVIDENCE",
              );
              if (failed) {
                assert.equal(saved.children[prefixCount + 1].state, "failed");
              }
              assert.equal(
                saved.children[waitIndex].state,
                stop === "interrupt" ? "paused" : detaching ? "completed" : "failed",
              );
              if (shape !== "parallel") {
                assertDefined(terminal.workflowGraph);
                assert.equal(
                  terminal.workflowGraph.nodes[1].status,
                  aggregateFailed ? "failed" : detaching ? "completed" : "paused",
                );
              }
              if (host === "foreground") {
                const text = initial.content.map((part) => textAt([part])).join("\n");
                if (detaching) {
                  assertDefined(initial.details.wait);
                  assert.equal(initial.details.wait.status, "yielded");
                  assert.deepEqual(
                    structuredClone(response),
                    initial,
                    "later completion must not mutate the yielded wait receipt",
                  );
                  assert.match(text, /Released the wait.*completion will arrive automatically/s);
                } else {
                  assert.equal(initial.isError, aggregateFailed ? true : undefined);
                  if (failed) {
                    assert.ok(text.includes(failureReason), `Missing failed-child reason: ${text}`);
                  }
                  if (!failed || stop === "timeout") {
                    assert.match(
                      text,
                      stop === "interrupt" ? /paused after interrupt/i : /timed out/i,
                    );
                  }
                }
              } else {
                assert.equal(record(terminal).success, false);
                assert.equal(record(terminal).state, failed ? "failed" : "paused");
                const notification = notifications.find((entry) => entry.runId === runId);
                assertDefined(notification);
                assert.equal(notification.status, failed ? "failed" : "paused");
                assertDefined(notification);
                assert.equal(record(array(notification.children)[waitIndex]).status, "paused");
                assertDefined(notification);
                assert.match(stringValue(notification.message), /SUCCESSFUL_SIBLING_EVIDENCE/);
                if (failed) {
                  assertDefined(notification);
                  assert.ok(stringValue(notification.message).includes(failureReason));
                }
              }
            } finally {
              watcher.stopResultWatcher();
              if (
                runId !== undefined &&
                runId.length > 0 &&
                !fs.existsSync(path.join(getRunMetadataDir(runId), "result.json"))
              ) {
                await invoke({ action: "interrupt", id: runId });
                await waitFor(
                  () => fs.existsSync(path.join(getRunMetadataDir(runId ?? ""), "result.json")),
                  "owned test run cleanup",
                );
              }
              await pending;
              tracker.resetJobs();
              if ((runId ?? "").length > 0) {
                assertDefined(runId);
                removeTempDir(path.join(ASYNC_DIR, runId));
                fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
                assertDefined(runId);
                removeTempDir(getRunMetadataDir(runId));
              }
              removeTempDir(cwd);
            }
          });
        }
      }
    }
  }
});
