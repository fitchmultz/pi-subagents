import type {
  TrackedOwnedRun,
  SavedLaunchConfig,
  SubagentState,
  AsyncResultFile,
} from "../../src/shared/types.ts";
import { toolText } from "../support/background-fixtures.ts";
import { readRunStatus } from "../support/run-publications.ts";
import { readChildCall } from "../support/child-process-receipts.ts";
import {
  assertDefined,
  textAt,
  record,
  array,
  records,
  readJson,
  text as stringValue,
} from "../support/assertions.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Check } from "typebox/value";
import { runInNewContext } from "node:vm";
import {
  createEventBus,
  createNativeSessionFixture,
  createMockPi,
  createTempDir,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";

const root = createTempDir("feedback-ux-");

process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const {
  AgentRunsValidationParams: AgentRunsParams,
  SubagentParams,
  AcceptanceOverride,
} = await import("../../src/extension/schemas.ts");
const { createSubagentExecutor, normalizeSubagentParamsLike } =
  await import("../../src/runs/foreground/subagent-executor.ts");
const { saveForegroundRun } = await import("../../src/runs/shared/run-records.ts");
const questions = await import("../../src/runs/shared/supervisor-questions.ts");
const { buildControlEvent, formatControlNoticeMessage } =
  await import("../../src/runs/shared/subagent-control.ts");
const { resolveEffectiveAcceptance } = await import("../../src/runs/shared/acceptance.ts");
const { inspectSubagentStatus } = await import("../../src/runs/background/run-status.ts");
const { formatAsyncStartedMessage } = await import("../../src/runs/background/async-execution.ts");
const { formatRunAction } = await import("../../src/shared/status-format.ts");
const native = await createNativeSessionFixture({ cwd: root, agentDir: path.join(root, "agent") });
after(async () => {
  await native.dispose();
  removeTempDir(root);
});

function setup(id: string) {
  const sessionFile = path.join(root, `${id}.jsonl`);
  fs.writeFileSync(sessionFile, "");
  const run: TrackedOwnedRun = {
    runId: id,
    rootRunId: id,
    ownerSessionId: "session-123",
    source: "foreground",
    mode: "single",
    cwd: root,
    task: `Task lead ${"long original task\n".repeat(150)}TASK-END`,
    startedAt: 1,
    children: [{ agent: "worker", index: 0, sessionFile }],
  };
  const launch: SavedLaunchConfig = {
    agent: {
      name: "worker",
      description: "Fixture",
      source: "project",
      filePath: "/fixture/worker.md",
      systemPrompt: "PRIVATE-PROMPT-END",
      systemPromptMode: "replace",
      inheritProjectContext: true,
      inheritSkills: false,
    },
    systemPrompt: "PRIVATE-PROMPT-END",
    skills: [],
    model: "fixture/original",
    modelCandidates: ["fixture/original"],
    cwd: root,
    context: "fresh",
    output: false,
    outputMode: "inline",
    artifacts: true,
    share: false,
  };
  questions.saveQuestionOwner(id, run.ownerSessionId);
  questions.saveQuestionContract(id, 0, { sessionFile, launch });
  const state: SubagentState = {
    baseCwd: root,
    currentSessionId: run.ownerSessionId,
    ownedRuns: new Map([[id, run]]),
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear() {
        /* The fixture does not need clear side effects. */
      },
    },
  };
  const events = createEventBus();
  const emitted: string[] = [];
  for (const event of [
    "subagent:live-intercom",
    "subagent:result-intercom",
    "subagent:async-started",
  ]) {
    events.on(event, () => {
      emitted.push(event);
    });
  }
  const executor = createSubagentExecutor({
    pi: { ...native.pi, events, getSessionName: () => "parent" },
    state,
    config: {},
    asyncByDefault: false,
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => root,
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [] }),
  });
  const child = {
    agent: "worker",
    task: run.task,
    exitCode: 0,
    finalOutput: "Short worker result",
    sessionFile,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  };
  saveForegroundRun({ ...run, results: [child] });
  return {
    run,
    launch,
    state,
    emitted,
    executor,
    sessionFile,
    child,
    execute: (params: Readonly<Record<string, unknown>>) =>
      executor.execute({
        toolCallId: "fixture",
        params: normalizeSubagentParamsLike(params),
        ctx: makeMinimalCtx(root),
      }),
  };
}

test("feedback inspect is compact by default, full is opt-in, and questions/errors/paths remain actionable", async () => {
  const fixture = setup("inspect-compact");
  const artifactPaths = {
    inputPath: path.join(root, "missing-input.md"),
    outputPath: path.join(root, "missing-output.md"),
    metadataPath: path.join(root, "missing-meta.json"),
  };
  const effectiveAcceptance = resolveEffectiveAcceptance({
    explicit: { criteria: ["Retain evidence"] },
  });
  saveForegroundRun({
    ...fixture.run,
    results: [
      {
        ...fixture.child,
        exitCode: 1,
        error: "Exact failure retained",
        artifactPaths,
        acceptance: {
          status: "rejected",
          explicit: true,
          inferredReason: [],
          effectiveAcceptance,
          criteria: effectiveAcceptance.criteria,
          runtimeChecks: [],
          verifyRuns: [],
        },
      },
    ],
  });
  const question = questions.createSupervisorQuestion({
    runId: fixture.run.runId,
    ownerTarget: "parent",
    agent: "worker",
    index: 0,
    childSessionId: "child",
    childTarget: "child",
    sessionFile: fixture.sessionFile,
    cwd: root,
    pid: 99999999,
    reason: "need_decision",
    message: "Choose the branch before continuing.",
  });
  const compact = await fixture.execute({ action: "status", id: fixture.run.runId });
  const text = toolText(compact.content);
  assert.doesNotMatch(text, /TASK-END|PRIVATE-PROMPT-END/);
  for (const value of [
    "Task lead",
    "Launch cwd:",
    "Exact failure retained",
    "validation: rejected",
    `${artifactPaths.outputPath} (missing)`,
    `${artifactPaths.metadataPath} (missing)`,
    fixture.sessionFile,
    question.questionId,
    "Choose the branch",
    'agent_runs({ action: "answer"',
    "full: true",
  ]) {
    assert.ok(text.includes(value), value);
  }
  assert.equal(compact.details.run?.task, fixture.run.task);
  assert.deepEqual(compact.details.run.children[0]?.launch, fixture.launch);
  assert.equal(compact.details.questions?.[0]?.questionId, question.questionId);
  const full = await fixture.execute({ action: "status", id: fixture.run.runId, full: true });
  assert.ok(
    full.content.some((part) => part.type === "text" && part.text.includes(fixture.run.task)),
  );
  assert.ok(
    full.content.some((part) => part.type === "text" && part.text.includes("PRIVATE-PROMPT-END")),
  );
  assert.deepEqual(
    full.details.run,
    compact.details.run,
    "compact presentation must not erase stored details",
  );
});

test("feedback review returns only a saved parent-decision receipt and never relays the note", async () => {
  const fixture = setup("review-receipt");
  const note = `IMPORTANT-REVIEW-NOTE ${"do not replay ".repeat(100)}`;
  const result = await fixture.execute({
    action: "review",
    id: fixture.run.runId,
    decision: "needs_changes",
    message: note,
  });
  const text = toolText(result.content);
  assert.ok(text.length < 450, "review is a receipt, not a second inspect");
  assert.match(text, /Saved parent review.*needs_changes/);
  assert.match(text, /parent-only.*not sent/);
  assert.match(text, /continue\/nudge/);
  assert.doesNotMatch(text, /TASK-END|PRIVATE-PROMPT-END|IMPORTANT-REVIEW-NOTE/);
  assert.equal(fixture.state.ownedRuns?.get(fixture.run.runId)?.review?.message, note);
  assert.equal(result.details.run?.state, "completed");
  assert.deepEqual(fixture.emitted, []);
});

test("feedback explicit continuation never replays a saved parent review as new child instructions", async () => {
  const { RESULTS_DIR } = await import("../../src/shared/types.ts");
  const fixture = setup("review-no-relay");
  const mock = createMockPi();
  mock.install();
  try {
    await fixture.execute({
      action: "review",
      id: fixture.run.runId,
      decision: "needs_changes",
      message: "PARENT-ONLY-REVIEW-NOTE",
    });
    mock.onCall({ output: "Follow-up finished" });
    const result = await fixture.execute({
      action: "resume",
      id: fixture.run.runId,
      message: "ONLY-NEW-ACTIONABLE-INSTRUCTION",
    });
    assert.ok(!(result.isError === true), textAt(result.content));
    const asyncId = result.details.asyncId;
    assertDefined(asyncId);
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(RESULTS_DIR, `${asyncId}.json`))) {
      assert.ok(Date.now() < deadline);
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await sleep(10);
    }
    const defined8714_0 = result.details.asyncDir;
    assertDefined(defined8714_0);
    const status = readRunStatus(path.join(defined8714_0, "status.json"));
    assertDefined(status.pid);
    while (questions.questionProcessAlive({ pid: status.pid })) {
      assert.ok(Date.now() < deadline);
      // Observe the owner publication before advancing this lifecycle transition.
      // oxlint-disable-next-line no-await-in-loop
      await sleep(10);
    }
    const calls = fs.readdirSync(mock.dir).filter((name) => name.startsWith("call-"));
    assert.equal(calls.length, 1);
    const call = readChildCall(path.join(mock.dir, calls[0]));
    assert.ok(call.expandedArgs.join("\n").includes("ONLY-NEW-ACTIONABLE-INSTRUCTION"));
    assert.ok(!call.expandedArgs.join("\n").includes("PARENT-ONLY-REVIEW-NOTE"));
    assertDefined(fixture.state.ownedRuns);
    const defined9348_0 = fixture.state.ownedRuns.get(fixture.run.runId);
    assertDefined(defined9348_0);
    assert.equal(defined9348_0.review?.decision, "needs_changes");
    assertDefined(result.details.asyncId);
    assertDefined(fixture.state.ownedRuns);
    const defined9469_0 = fixture.state.ownedRuns.get(result.details.asyncId);
    assertDefined(defined9469_0);
    assert.equal(defined9469_0.review, undefined);
  } finally {
    mock.uninstall();
  }
});

test("feedback completion and compact receipts expose existing result/acceptance metadata without inventing disabled artifacts", async () => {
  const { createResultWatcher } = await import("../../src/runs/background/result-watcher.ts");
  const fixture = setup("metadata-pointer");
  const artifactPaths = {
    inputPath: path.join(root, "short-input.md"),
    outputPath: path.join(root, "short-output.md"),
    metadataPath: path.join(root, "acceptance-meta.json"),
  };
  fs.writeFileSync(artifactPaths.outputPath, "Short summary");
  fs.writeFileSync(
    artifactPaths.metadataPath,
    JSON.stringify({
      acceptance: { status: "passed", childReport: { changedFiles: ["proof.ts"] } },
    }),
  );
  const bus = createEventBus();
  const deliveries: unknown[] = [];
  bus.on("subagent:result-intercom", (raw) => {
    const payload = record(raw);
    deliveries.push(raw);
    bus.emit("subagent:result-intercom-delivery", {
      requestId: stringValue(payload.requestId),
      delivered: true,
    });
  });
  const resultsDir = path.join(root, "metadata-results");
  fs.mkdirSync(resultsDir);
  const runId = "metadata-async";
  const data: AsyncResultFile = {
    id: runId,
    sessionId: fixture.run.ownerSessionId,
    mode: "single",
    state: "complete",
    success: true,
    timestamp: Date.now(),
    intercomTarget: "parent",
    results: [
      { agent: "worker", success: true, exitCode: 0, output: "Short summary", artifactPaths },
    ],
  };
  questions.saveAsyncRunResult(runId, data);
  fs.writeFileSync(path.join(resultsDir, `${runId}.json`), JSON.stringify(data));
  const completed = new Promise<void>((resolve) => {
    bus.on("subagent:async-complete", () => resolve());
  });
  const watcher = createResultWatcher({ events: bus }, fixture.state, resultsDir);
  try {
    watcher.primeExistingResults();
    await completed;
    const payload = record(deliveries[0]);
    assert.equal(record(array(payload.children)[0]).metadataPath, artifactPaths.metadataPath);
    assert.ok(stringValue(payload.message).includes(artifactPaths.metadataPath));
    const resultPath = stringValue(payload.resultPath);
    assert.ok(resultPath.endsWith("result.json") && fs.existsSync(resultPath));
  } finally {
    watcher.stopResultWatcher();
  }
  const disabledId = "metadata-disabled";
  const disabled = {
    ...data,
    id: disabledId,
    results: [{ agent: "worker", success: true, exitCode: 0, output: "No artifacts" }],
  };
  questions.saveAsyncRunResult(disabledId, disabled);
  fs.writeFileSync(path.join(resultsDir, `${disabledId}.json`), JSON.stringify(disabled));
  const disabledDone = new Promise<void>((resolve) => {
    bus.on("subagent:async-complete", (event) => {
      if (record(event).runId === disabledId) {
        resolve();
      }
    });
  });
  const disabledWatcher = createResultWatcher({ events: bus }, fixture.state, resultsDir);
  try {
    disabledWatcher.primeExistingResults();
    await disabledDone;
    const payload = record(deliveries.find((delivery) => record(delivery).runId === disabledId));
    assert.equal(record(array(payload.children)[0]).metadataPath, undefined);
    assert.doesNotMatch(stringValue(payload.message), /Result metadata \(/);
  } finally {
    disabledWatcher.stopResultWatcher();
  }
});

test("feedback public and advanced schemas expose full inspection and explain unchanged acceptance/review policies", () => {
  assert.equal(Check(AgentRunsParams, { action: "inspect", id: "run", full: true }), true);
  assert.equal(
    Check(AgentRunsParams, { action: "nudge", id: "run", message: "go", full: true }),
    false,
  );
  assert.equal(Check(AgentRunsParams, { action: "extend", id: "run" }), false);
  assert.equal(Check(SubagentParams, { action: "status", runId: "run", full: true }), true);
  assert.equal(Check(SubagentParams, { action: "status", full: true }), false);
  assert.equal(normalizeSubagentParamsLike({ action: "status", full: true }).full, true);
  assert.match(
    stringValue(record(AgentRunsParams.properties.message).description),
    /parent-only.*not sent/,
  );
  assert.match(stringValue(record(SubagentParams.properties.message).description), /not sent/);
  assert.match(
    stringValue(record(AcceptanceOverride).description),
    /entire Git index.*pre-existing staged/,
  );
  assert.match(
    stringValue(record(AcceptanceOverride).description),
    /never to a live child's acceptance/,
  );
  for (const schema of [AgentRunsParams, SubagentParams]) {
    assert.equal(Check(schema, { action: "questions", offset: 20, limit: 5 }), true);
    assert.equal(Check(schema, { action: "questions", id: "run", questionId: "question" }), true);
    assert.equal(Check(schema, { action: "questions", limit: 101 }), false);
  }
});

for (const surface of ["parent", "child-compact", "child-legacy"]) {
  test(`feedback ${surface} controls advertise surface-appropriate tool/action pairs`, (t) => {
    const childSafe = surface !== "parent",
      legacy = surface === "child-legacy";
    const configPath = path.join(root, "agent/extensions/subagent/config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ compactChildTools: !legacy }));
    t.after(() => fs.rmSync(configPath));
    const failedTool = formatControlNoticeMessage(
      buildControlEvent({
        runId: "failed-tool",
        agent: "worker",
        to: "needs_attention",
        reason: "tool_failures",
        message: "Repeated edit failures",
        currentTool: "edit",
      }),
      "worker",
      childSafe,
    );
    assert.match(failedTool, /Repeated edit failures/);
    assert.doesNotMatch(
      failedTool,
      /Inspect command progress|still active|long-running tool/,
      "a completed failed tool is not an active long tool",
    );
    const control = {
      runtimeVersion: 2 as const,
      runId: `live-control-${childSafe}`,
      mode: "single" as const,
      state: "running" as const,
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      pid: process.pid,
      timeoutAt: Date.now() + 60000,
      steps: [{ agent: "worker", status: "running" as const }],
    };
    questions.saveRunStatus(control.runId, control);
    const text = [
      textAt(
        inspectSubagentStatus(
          { id: control.runId },
          { nested: childSafe ? { routes: [] } : undefined },
        ).content,
      ),
      formatAsyncStartedMessage("Started", childSafe),
      formatControlNoticeMessage(
        buildControlEvent({ runId: control.runId, agent: "worker", to: "needs_attention" }),
        "worker",
        childSafe,
      ),
      formatRunAction("extend", control.runId, { extendMs: 1000 }, childSafe),
    ].join("\n");
    if (legacy) {
      assert.match(text, /subagent\(\{ action: "status"/);
      assert.match(text, /subagent\(\{ action: "interrupt"/);
      assert.doesNotMatch(text, /agent_runs|load_subagent/);
    } else {
      assert.match(text, /agent_runs\(\{ action: "inspect"/);
      assert.match(text, /agent_runs\(\{ action: "stop"/);
      assert.match(text, /agent_runs\(\{ action: "nudge"/);
      assert.match(text, /load_subagent\(\{\}\), then subagent\(\{ action: "extend"/);
      assert.doesNotMatch(
        text,
        /subagent\(\{ action: "(?:status|nudge|resume|interrupt)"|agent_runs\(\{ action: "extend"/,
      );
    }
  });
}

test("feedback child-safe launch and completion hints do not depend on a live nested route", async () => {
  const { buildSubagentResultIntercomPayload } =
    await import("../../src/intercom/result-intercom.ts");
  const keys = [
    "PI_SUBAGENT_CHILD",
    "PI_SUBAGENT_FANOUT_CHILD",
    "PI_SUBAGENT_PARENT_EVENT_SINK",
    "PI_SUBAGENT_PARENT_ROOT_RUN_ID",
    "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN",
  ];
  const previous = keys.map((key) => process.env[key]);
  process.env.PI_SUBAGENT_CHILD = "1";
  process.env.PI_SUBAGENT_FANOUT_CHILD = "1";
  for (const key of keys.slice(2)) {
    delete process.env[key];
  }
  try {
    const fixture = setup("child-safe-hints");
    const text = [
      formatAsyncStartedMessage("Started"),
      buildSubagentResultIntercomPayload({
        to: "parent",
        runId: fixture.run.runId,
        asyncId: fixture.run.runId,
        mode: "single",
        source: "async",
        children: [
          {
            agent: "worker",
            status: "completed",
            summary: "Done",
            sessionPath: fixture.sessionFile,
          },
        ],
      }).message,
    ].join("\n");
    assert.match(text, /agent_runs\(\{ action: "inspect"/);
    assert.match(text, /agent_runs\(\{ action: "continue"/);
    assert.doesNotMatch(text, /subagent\(\{ action: "(?:status|resume)"/);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[index];
      }
    });
  }
});

test("feedback durable wait requires the exact run/child/session/process and retains undelivered answers", () => {
  const fixture = setup("wait-identity");
  const input = {
    runId: fixture.run.runId,
    agent: "worker",
    index: 0,
    sessionFile: fixture.sessionFile,
    pid: process.pid,
  };
  const event = () =>
    buildControlEvent({
      ...input,
      to: "needs_attention",
      ts: 700000,
      lastActivityAt: 99999,
      currentTool: "contact_supervisor",
      currentToolDurationMs: 600001,
      supervisorQuestion: questions.pendingSupervisorQuestion(input),
    });
  assert.equal(event().supervisorQuestion, undefined, "tool name alone proves no durable wait");
  const question = questions.createSupervisorQuestion({
    ...input,
    ownerTarget: "parent",
    childSessionId: "child",
    childTarget: "child",
    cwd: root,
    reason: "need_decision",
    message: "Choose one.",
  });
  for (const mismatch of [
    { runId: "different" },
    { agent: "other" },
    { index: 1 },
    { sessionFile: `${fixture.sessionFile}.other` },
    { pid: process.pid + 1 },
  ]) {
    assert.equal(questions.pendingSupervisorQuestion({ ...input, ...mismatch }), undefined);
  }
  const waiting = formatControlNoticeMessage(event());
  assert.match(waiting, /Waiting for supervisor input/);
  assert.ok(waiting.includes(question.questionId));
  assert.match(waiting, /agent_runs\(\{ action: "answer"/);
  assert.doesNotMatch(waiting, /waiting for user|What are you blocked on/i);
  questions.saveQuestionAnswer(question, 'Saved "exact" answer');
  const pending = formatControlNoticeMessage(event());
  assert.match(pending, /delivery unconfirmed/);
  assert.ok(pending.includes(JSON.stringify('Saved "exact" answer')));
  questions.recordQuestionDelivery(question, {
    kind: "live",
    runId: input.runId,
    deliveredAt: Date.now(),
  });
  assert.equal(event().supervisorQuestion, undefined);
  assert.match(
    formatControlNoticeMessage(event()),
    /contact_supervisor still active for 600s; no observed output\/events for 600s/,
  );
});

test("question outputs page compact views while full questions, interviews and immutable answers remain recoverable", async () => {
  const fixture = setup("question-output-growth");
  const baseline = Array.from({ length: 10_000 }, (_, index) => `native-entry-${index}`);
  questions.saveQuestionContract(fixture.run.runId, 0, { attemptBaseline: baseline });
  const saved = Array.from({ length: 25 }, (_, index) =>
    questions.createSupervisorQuestion({
      runId: fixture.run.runId,
      ownerTarget: "parent",
      agent: "worker",
      index: 0,
      childSessionId: "child",
      childTarget: "child",
      sessionFile: fixture.sessionFile,
      cwd: root,
      pid: process.pid,
      reason: "interview_request",
      message:
        index === 24
          ? `QUESTION-LEAD ${"large question ".repeat(2000)} QUESTION-END`
          : `Choose branch ${index}.`,
      interview: {
        questions: [
          {
            id: "choice",
            type: "text",
            question: `INTERVIEW ${"context ".repeat(2000)} INTERVIEW-END`,
          },
        ],
      },
    }),
  );
  const files = saved.map((question) =>
    path.join(
      questions.getRunMetadataDir(question.runId),
      "questions",
      question.questionId,
      "question.json",
    ),
  );
  const before = files.map((file) => fs.readFileSync(file, "utf8"));
  const first = await fixture.execute({ action: "questions", id: fixture.run.runId });
  assert.ok(
    Buffer.byteLength(JSON.stringify(first)) < 200_000,
    "a questions page must not serialize growing launch/baseline/interview metadata",
  );
  assert.equal(first.details.questions?.length, 20);
  assert.deepEqual(first.details.questionList, { total: 25, offset: 0, limit: 20, nextOffset: 20 });
  assert.match(textAt(first.content), /offset: 20/);
  const second = await fixture.execute({
    action: "questions",
    id: fixture.run.runId,
    offset: first.details.questionList.nextOffset,
  });
  assert.equal(second.details.questions?.length, 5);
  assert.equal(second.details.questionList?.nextOffset, undefined);
  assert.equal(
    new Set(
      [...first.details.questions, ...second.details.questions].map(
        (question) => question.questionId,
      ),
    ).size,
    25,
  );
  for (const question of first.details.questions) {
    for (const field of ["attemptBaseline", "launch", "interview"]) {
      assert.equal(field in question, false);
    }
    assert.equal(question.hasInterview, true);
    assert.ok(files.includes(question.questionPath));
  }
  const last = saved[24];
  const exact = await fixture.execute({
    action: "questions",
    id: last.runId,
    questionId: last.questionId,
  });
  assert.equal(
    exact.details.questions?.length,
    1,
    "exact lookup must not depend on which page contains the question",
  );
  assert.match(textAt(exact.content), /QUESTION-LEAD/);
  assert.doesNotMatch(textAt(exact.content), /QUESTION-END/);
  assert.ok(textAt(exact.content).includes(files[24]));
  assertDefined(exact.details.questions);
  assert.equal(exact.details.questions[0].messageTruncated, true);
  assert.deepEqual(
    files.map((file) => fs.readFileSync(file, "utf8")),
    before,
    "browsing must not rewrite durable question/launch history",
  );
  const recovered = record(readJson(exact.details.questions[0].questionPath));
  assert.equal(recovered.message, last.message);
  assert.deepEqual(recovered.interview, last.interview);
  assert.deepEqual(recovered.attemptBaseline, baseline);
  assert.equal(record(recovered.launch).systemPrompt, fixture.launch.systemPrompt);
  const answer = `ANSWER-LEAD ${"saved answer ".repeat(2000)} ANSWER-END`;
  const receipt = await fixture.execute({
    action: "answer",
    id: last.runId,
    questionId: last.questionId,
    message: answer,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 20_000);
  assert.equal(receipt.details.questions?.[0]?.state, "answer_pending");
  const answerPath = receipt.details.questions[0].answerPath;
  assertDefined(answerPath);
  assert.equal(record(readJson(answerPath)).message, answer);
  assert.equal(
    (
      await fixture.execute({
        action: "answer",
        id: last.runId,
        questionId: last.questionId,
        message: answer,
      })
    ).isError,
    undefined,
  );
  assert.equal(
    (
      await fixture.execute({
        action: "answer",
        id: last.runId,
        questionId: last.questionId,
        message: "conflict",
      })
    ).isError,
    true,
  );
  questions.claimQuestionRevival(last);
  const status = await fixture.execute({ action: "status", id: last.runId });
  assert.ok(Buffer.byteLength(JSON.stringify(status.details.questions)) < 100_000);
  const statusQuestions = status.details.questions;
  assertDefined(statusQuestions);
  const nextCall = textAt(status.content).match(/^More questions: (.+)$/m)?.[1];
  assertDefined(nextCall);
  const nextResult: unknown = await runInNewContext(nextCall, { agent_runs: fixture.execute });
  const nextDetails = record(record(nextResult).details);
  assert.equal(
    record(nextDetails.questionList).offset,
    20,
    "the advertised status continuation must advance past the shown page",
  );
  assert.equal(records(nextDetails.questions).length, 5);
  assert.ok(
    records(nextDetails.questions).every(
      (question) => !statusQuestions.some((shown) => shown.questionId === question.questionId),
    ),
  );
  const refreshed = await fixture.execute({
    action: "questions",
    id: last.runId,
    questionId: last.questionId,
  });
  assert.equal(refreshed.details.questions?.[0]?.answerTruncated, true);
  assert.match(textAt(refreshed.content), /Continuation requested:.*delivery unconfirmed/);
  assert.match(textAt(refreshed.content), /Recover an unlaunched continuation/);
  assert.ok(textAt(refreshed.content).includes(answerPath));
  assert.doesNotMatch(
    textAt(refreshed.content),
    /message: "ANSWER-LEAD/,
    "a truncated preview must never become a conflicting retry answer",
  );
  const cancelled = await fixture.execute({ action: "interrupt", id: last.runId });
  assert.equal(cancelled.isError, undefined, textAt(cancelled.content));
  assert.ok(Buffer.byteLength(JSON.stringify(cancelled)) < 200_000);
  assert.equal(cancelled.details.questionList?.total, 25);
  assert.ok(
    saved.every((question) => questions.readQuestionState(question).state === "cancelled"),
    "page size must not limit cancellation",
  );
  assert.deepEqual(
    files.map((file) => fs.readFileSync(file, "utf8")),
    before,
  );
  assert.equal(record(readJson(answerPath)).message, answer);
  for (const params of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }]) {
    assert.equal(
      // Native publication/cursor state must settle before advancing this sequence.
      // oxlint-disable-next-line no-await-in-loop
      (await fixture.execute({ action: "questions", ...params })).isError,
      true,
      JSON.stringify(params),
    );
  }
});
