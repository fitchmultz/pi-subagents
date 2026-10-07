import {
  assertDefined,
  record,
  records,
  text as stringValue,
  array,
} from "../support/assertions.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setImmediate as nextDispatch } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import {
  createNativeSessionFixture,
  createTempDir,
  removeTempDir,
  createEventBus,
  makeAgent,
  makeMinimalCtx,
} from "../support/helpers.ts";

import { validateExecutionInput } from "../../src/runs/foreground/execution-input.ts";
import { normalizeSubagentParamsLike } from "../../src/runs/foreground/subagent-executor.ts";

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

type RegisteredSlashCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

import { registerSlashCommands } from "../../src/slash/slash-commands.ts";
import { registerSlashSubagentBridge } from "../../src/slash/slash-bridge.ts";
import {
  clearSlashSnapshots,
  getSlashRenderableSnapshot,
  resolveSlashMessageDetails,
} from "../../src/slash/slash-live-state.ts";

function createState(cwd: string) {
  return {
    baseCwd: cwd,
    currentSessionId: null,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {
        /* The fixture does not need clear side effects. */
      },
    },
  };
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-home-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const nativeRoot = createTempDir("slash-sdk-");
const native = await createNativeSessionFixture({ cwd: nativeRoot, agentDir: nativeRoot });
after(async () => {
  await native.dispose();
  removeTempDir(nativeRoot);
});

function createCommandContext(
  overrides: Readonly<
    Partial<{
      cwd: string;
      hasUI: boolean;
      notify: ExtensionCommandContext["ui"]["notify"];
      setStatus: ExtensionCommandContext["ui"]["setStatus"];
      getToolsExpanded: () => boolean;
      setToolsExpanded: (expanded: boolean) => void;
    }>
  > = {},
): ExtensionCommandContext {
  const base = native.session.extensionRunner.createCommandContext();
  return {
    ...base,
    cwd: overrides.cwd ?? process.cwd(),
    mode: overrides.hasUI === true ? "tui" : "json",
    hasUI: overrides.hasUI ?? false,
    ui: {
      ...base.ui,
      notify: overrides.notify ?? base.ui.notify.bind(base.ui),
      setStatus: overrides.setStatus ?? base.ui.setStatus.bind(base.ui),
      getToolsExpanded: overrides.getToolsExpanded ?? base.ui.getToolsExpanded.bind(base.ui),
      setToolsExpanded: overrides.setToolsExpanded ?? base.ui.setToolsExpanded.bind(base.ui),
    },
  };
}

async function withTempProject<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pi", "chains"), { recursive: true });
  try {
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeProjectChain(root: string, fileName: string, content: string): void {
  fs.writeFileSync(path.join(root, ".pi", "chains", fileName), content, "utf-8");
}

function requestPayload(value: unknown): { readonly requestId: string; readonly params?: unknown } {
  const payload = record(value);
  return { params: payload.params, requestId: stringValue(payload.requestId) };
}

async function captureSlashCommandParams(
  commandName: string,
  args: string,
  cwd: string,
  setup?: () => void,
): Promise<{ params: unknown; notifications: string[] }> {
  return withIsolatedHome(async () => {
    setup?.();
    const commands = new Map<string, RegisteredSlashCommand>();
    const events = createEventBus();
    let requestedParams: unknown;
    const notifications: string[] = [];
    events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
      const payload = requestPayload(data);
      requestedParams = payload.params;
      events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
      events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
        requestId: payload.requestId,
        result: {
          content: [{ type: "text", text: `${commandName} finished` }],
          details: { mode: "chain", results: [] },
        },
        isError: false,
      });
    });

    const pi: ExtensionAPI = {
      ...native.pi,
      events,
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerShortcut() {
        /* The fixture does not need registerShortcut side effects. */
      },
      sendMessage(_message: unknown) {
        /* The fixture does not need sendMessage side effects. */
      },
    };

    registerSlashCommands(pi, createState(cwd));
    const defined5833_0 = commands.get(commandName);
    assertDefined(defined5833_0);
    await defined5833_0.handler(
      args,
      createCommandContext({
        cwd,
        notify: (message) => {
          notifications.push(message);
        },
      }),
    );
    return { params: requestedParams, notifications };
  });
}

describe("slash command custom message delivery", () => {
  it("native bridge correlates malformed task and chain errors without starting or executing them", async () => {
    const events = createEventBus();
    const replies: Readonly<Record<string, unknown>>[] = [];
    const started: string[] = [];
    let executed = 0;
    const barrier = new Promise<void>((resolve) => {
      events.on(SLASH_SUBAGENT_RESPONSE_EVENT, (raw) => {
        const reply = record(raw);
        replies.push(reply);
        if (reply.requestId === "dispatch-barrier") {
          resolve();
        }
      });
    });
    events.on(SLASH_SUBAGENT_STARTED_EVENT, (raw) => {
      started.push(stringValue(record(raw).requestId));
    });
    const bridge = registerSlashSubagentBridge({
      events,
      getContext: () => makeMinimalCtx(nativeRoot),
      execute: async () => {
        executed++;
        throw new Error("Fixture executor failure");
      },
    });
    try {
      events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
        requestId: "malformed-tasks",
        params: { tasks: "wrong" },
      });
      events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
        requestId: "malformed-chain",
        params: { chain: [{}] },
      });
      events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
        requestId: "dispatch-barrier",
        params: { agent: "worker", task: "valid request" },
      });
      await barrier;
      await nextDispatch();
      assert.deepEqual(
        replies
          .map((reply) => stringValue(reply.requestId))
          .sort((left, right) => left.localeCompare(right)),
        ["dispatch-barrier", "malformed-chain", "malformed-tasks"],
      );
      const tasks = replies.find((reply) => reply.requestId === "malformed-tasks");
      const chain = replies.find((reply) => reply.requestId === "malformed-chain");
      assertDefined(tasks);
      assertDefined(chain);
      assert.equal(tasks.isError, true);
      assert.equal(chain.isError, true);
      assert.match(
        stringValue(tasks.errorText),
        /tasks must be an array of task objects with an agent/,
      );
      assert.match(
        stringValue(chain.errorText),
        /chain must contain valid sequential, parallel, or dynamic fanout steps/,
      );
      assert.match(
        stringValue(record(array(record(tasks.result).content)[0]).text),
        /tasks must be an array/,
      );
      assert.match(
        stringValue(record(array(record(chain.result).content)[0]).text),
        /chain must contain valid/,
      );
      assert.equal(executed, 1);
      assert.deepEqual(started, ["dispatch-barrier"]);
    } finally {
      bridge.dispose();
    }
  });

  beforeEach(() => {
    clearSlashSnapshots();
  });

  it("/run accepts an agent without a task", async () => {
    const sent: unknown[] = [];
    const commands = new Map<string, RegisteredSlashCommand>();
    const events = createEventBus();
    let requestedParams: unknown;
    events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
      const payload = requestPayload(data);
      requestedParams = payload.params;
      events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
      events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
        requestId: payload.requestId,
        result: {
          content: [{ type: "text", text: "Commit finished" }],
          details: { mode: "single", results: [] },
        },
        isError: false,
      });
    });

    const pi: ExtensionAPI = {
      ...native.pi,
      events,
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerShortcut() {
        /* The fixture does not need registerShortcut side effects. */
      },
      sendMessage(message: unknown) {
        sent.push(message);
      },
    };

    registerSlashCommands(pi, createState(process.cwd()));
    const defined7347_0 = commands.get("run");
    assertDefined(defined7347_0);
    await defined7347_0.handler("scout", createCommandContext());

    assert.deepEqual(requestedParams, {
      agent: "scout",
      task: "",
      clarify: false,
      agentScope: "both",
    });
    assert.equal(sent.length, 2);
    assert.equal(record(sent[0]).display, true);
    assert.equal(record(sent[0]).content, "Running subagent...");
    assert.equal(record(sent[1]).display, false);
    assert.match(stringValue(record(sent[1]).content), /Commit finished/);
  });

  it("/run finalizes the slash snapshot before the last UI redraw on success", async () => {
    const sent: unknown[] = [];
    const log: string[] = [];
    const commands = new Map<string, RegisteredSlashCommand>();
    const events = createEventBus();
    events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
      const requestId = stringValue(record(data).requestId);
      events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
      events.emit(SLASH_SUBAGENT_UPDATE_EVENT, { requestId, toolCount: 2, currentTool: "read" });
      events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
        requestId,
        result: {
          content: [{ type: "text", text: "Scout finished" }],
          details: { mode: "single", results: [{ sessionFile: "/tmp/child-session.jsonl" }] },
        },
        isError: false,
      });
    });

    const pi: ExtensionAPI = {
      ...native.pi,
      events,
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerShortcut() {
        /* The fixture does not need registerShortcut side effects. */
      },
      sendMessage(message: unknown) {
        sent.push(message);
        log.push(`send:${record(message).display === false ? "hidden" : "visible"}`);
      },
    };

    registerSlashCommands(pi, createState(process.cwd()));
    const defined9256_0 = commands.get("run");
    assertDefined(defined9256_0);
    await defined9256_0.handler(
      "scout inspect this",
      createCommandContext({
        hasUI: true,
        setStatus: (_key, text) => {
          log.push(`status:${text ?? "clear"}`);
        },
      }),
    );

    assert.equal(sent.length, 2);
    assert.equal(record(sent[0]).customType, SLASH_RESULT_TYPE);
    assert.equal(record(sent[0]).display, true);
    assert.equal(record(sent[0]).content, "inspect this");
    assert.equal(record(sent[1]).customType, SLASH_RESULT_TYPE);
    assert.equal(record(sent[1]).display, false);
    assert.match(stringValue(record(sent[1]).content), /Scout finished/);
    assert.match(
      stringValue(record(sent[1]).content),
      /Child session exports\n\n- `\/tmp\/child-session\.jsonl`/,
    );
    assert.deepEqual(log, [
      "send:visible",
      "status:running...",
      "status:2 tools read",
      "send:hidden",
      "status:clear",
    ]);

    const visibleDetails = resolveSlashMessageDetails(record(sent[0]).details);
    assert.ok(visibleDetails);
    const visibleSnapshot = getSlashRenderableSnapshot(visibleDetails);
    assert.equal(record(visibleSnapshot.result.content[0]).text, "Scout finished");
  });

  it("/run preserves tool output expansion before showing the initial live card", async () => {
    const log: string[] = [];
    const commands = new Map<string, RegisteredSlashCommand>();
    const events = createEventBus();
    events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
      const requestId = stringValue(record(data).requestId);
      events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
      events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
        requestId,
        result: {
          content: [{ type: "text", text: "done" }],
          details: { mode: "single", results: [] },
        },
        isError: false,
      });
    });

    const pi: ExtensionAPI = {
      ...native.pi,
      events,
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerShortcut() {
        /* The fixture does not need registerShortcut side effects. */
      },
      sendMessage() {
        log.push("send");
      },
    };

    registerSlashCommands(pi, createState(process.cwd()));
    let expanded = false;
    const defined11737_0 = commands.get("run");
    assertDefined(defined11737_0);
    const run = defined11737_0;
    const ctx = createCommandContext({
      hasUI: true,
      getToolsExpanded: () => expanded,
      setToolsExpanded: (value) => {
        expanded = value;
        log.push(`expanded:${String(value)}`);
      },
    });
    await run.handler("scout inspect this", ctx);
    assert.equal(
      log.some((entry) => entry.startsWith("expanded:")),
      false,
    );

    log.length = 0;
    expanded = true;
    await run.handler("scout inspect this", ctx);
    assert.equal(
      log.some((entry) => entry.startsWith("expanded:")),
      false,
    );
    assert.equal(expanded, true);
    assert.equal(log[0], "send");
  });

  it("/run finalizes the slash snapshot before the last UI redraw on error", async () => {
    const sent: unknown[] = [];
    const log: string[] = [];
    const commands = new Map<string, RegisteredSlashCommand>();
    const events = createEventBus();
    events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
      const requestId = stringValue(record(data).requestId);
      events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
      events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
        requestId,
        result: {
          content: [{ type: "text", text: "Subagent failed" }],
          details: { mode: "single", results: [] },
        },
        isError: true,
        errorText: "Subagent failed",
      });
    });

    const pi: ExtensionAPI = {
      ...native.pi,
      events,
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerShortcut() {
        /* The fixture does not need registerShortcut side effects. */
      },
      sendMessage(message: unknown) {
        sent.push(message);
        log.push(`send:${record(message).display === false ? "hidden" : "visible"}`);
      },
    };

    registerSlashCommands(pi, createState(process.cwd()));
    const defined13657_0 = commands.get("run");
    assertDefined(defined13657_0);
    await defined13657_0.handler(
      "scout inspect this",
      createCommandContext({
        hasUI: true,
        setStatus: (_key, text) => {
          log.push(`status:${text ?? "clear"}`);
        },
      }),
    );

    assert.equal(sent.length, 2);
    assert.equal(record(sent[0]).customType, SLASH_RESULT_TYPE);
    assert.equal(record(sent[0]).display, true);
    assert.equal(record(sent[0]).content, "inspect this");
    assert.equal(record(sent[1]).customType, SLASH_RESULT_TYPE);
    assert.equal(record(sent[1]).display, false);
    assert.match(stringValue(record(sent[1]).content), /Subagent failed/);
    assert.deepEqual(log, ["send:visible", "status:running...", "send:hidden", "status:clear"]);

    const visibleDetails = resolveSlashMessageDetails(record(sent[0]).details);
    assert.ok(visibleDetails);
    const visibleSnapshot = getSlashRenderableSnapshot(visibleDetails);
    assert.equal(record(visibleSnapshot.result.content[0]).text, "Subagent failed");
  });

  it("/parallel forwards inline output behavior config", async () => {
    const commands = new Map<string, RegisteredSlashCommand>();
    const events = createEventBus();
    let requestedParams: unknown;
    events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
      const payload = requestPayload(data);
      requestedParams = payload.params;
      events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
      events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
        requestId: payload.requestId,
        result: {
          content: [{ type: "text", text: "parallel finished" }],
          details: { mode: "parallel", results: [] },
        },
        isError: false,
      });
    });

    const pi: ExtensionAPI = {
      ...native.pi,
      events,
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerShortcut() {
        /* The fixture does not need registerShortcut side effects. */
      },
      sendMessage(_message: unknown) {
        /* The fixture does not need sendMessage side effects. */
      },
    };

    registerSlashCommands(pi, createState(process.cwd()));
    const parallelCommand = commands.get("parallel");
    assertDefined(parallelCommand);
    await parallelCommand.handler(
      "scout[output=x.md,outputMode=file-only,reads=a.md+b.md,progress] -- Review",
      createCommandContext(),
    );

    assert.deepEqual(requestedParams, {
      tasks: [
        {
          agent: "scout",
          task: "Review",
          output: "x.md",
          outputMode: "file-only",
          reads: ["a.md", "b.md"],
          progress: true,
        },
      ],
      clarify: false,
      agentScope: "both",
    });
  });

  it("/parallel no longer hard-blocks runs above the old 8-task limit before the executor responds", async () => {
    const sent: unknown[] = [];
    const commands = new Map<string, RegisteredSlashCommand>();
    const events = createEventBus();
    let requestedTasks = 0;
    events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
      const payload = requestPayload(data);
      requestedTasks = array(record(payload.params).tasks).length;
      events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
      events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
        requestId: payload.requestId,
        result: {
          content: [{ type: "text", text: "parallel finished" }],
          details: { mode: "parallel", results: [] },
        },
        isError: false,
      });
    });

    const pi: ExtensionAPI = {
      ...native.pi,
      events,
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
      registerShortcut() {
        /* The fixture does not need registerShortcut side effects. */
      },
      sendMessage(message: unknown) {
        sent.push(message);
      },
    };

    registerSlashCommands(pi, createState(process.cwd()));
    const args = Array.from({ length: 9 }, (_, index) => `scout "task ${index + 1}"`).join(" -> ");
    const defined17803_0 = commands.get("parallel");
    assertDefined(defined17803_0);
    await defined17803_0.handler(args, createCommandContext());

    assert.equal(requestedTasks, 9);
    assert.equal(sent.length, 2);
    assert.match(stringValue(record(sent[1]).content), /parallel finished/);
  });
});

describe("saved chain slash command", () => {
  beforeEach(() => {
    clearSlashSnapshots();
  });

  it("/run and /chain accept dotted packaged runtime agent names", async () => {
    await withTempProject("pi-packaged-agent-slash-", async (root) => {
      fs.writeFileSync(
        path.join(root, ".pi", "agents", "code-analysis.scout.md"),
        `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`,
        "utf-8",
      );
      fs.writeFileSync(
        path.join(root, ".pi", "agents", "documentation.writer.md"),
        `---
name: writer
package: documentation
description: Writer
---

Write
`,
        "utf-8",
      );

      const run = await captureSlashCommandParams("run", "code-analysis.scout Investigate", root);
      assert.deepEqual(run.params, {
        agent: "code-analysis.scout",
        task: "Investigate",
        clarify: false,
        agentScope: "both",
      });

      const chain = await captureSlashCommandParams(
        "chain",
        'code-analysis.scout "Scan" -> documentation.writer',
        root,
      );
      assert.deepEqual(
        records(record(chain.params).chain).map(({ agent, task }) => ({ agent, task })),
        [
          { agent: "code-analysis.scout", task: "Scan" },
          { agent: "documentation.writer", task: undefined },
        ],
      );

      await withIsolatedHome(async () => {
        const commands = new Map<string, RegisteredSlashCommand>();
        const pi: ExtensionAPI = {
          ...native.pi,
          events: createEventBus(),
          registerCommand(name, spec) {
            commands.set(name, spec);
          },
          registerShortcut() {
            /* The fixture does not need registerShortcut side effects. */
          },
          sendMessage(_message: unknown) {
            /* The fixture does not need sendMessage side effects. */
          },
        };
        registerSlashCommands(pi, createState(root));
        const registeredRunCommand = commands.get("run");
        assertDefined(registeredRunCommand);
        const defined19907_0 = registeredRunCommand.getArgumentCompletions;
        assertDefined(defined19907_0);
        const runCompletions = await defined19907_0("code-");
        assertDefined(runCompletions);
        assert.deepEqual(
          runCompletions.map((completion) => completion.value),
          ["code-analysis.scout"],
        );
        const registeredChainCommand = commands.get("chain");
        assertDefined(registeredChainCommand);
        const defined20201_0 = registeredChainCommand.getArgumentCompletions;
        assertDefined(defined20201_0);
        const chainCompletions = await defined20201_0('code-analysis.scout "Scan" -> doc');
        assertDefined(chainCompletions);
        assertDefined(chainCompletions);
        assert.deepEqual(
          chainCompletions.map((completion) => completion.value),
          ['code-analysis.scout "Scan" -> documentation.writer'],
        );
      });
    });
  });

  it("/run-chain launches a saved chain with a shared task", async () => {
    await withTempProject("pi-run-chain-success-", async (root) => {
      writeProjectChain(
        root,
        "review-flow.chain.md",
        `---
name: review-flow
description: Review flow
---

## scout

Scan {task}

## reviewer

Review {previous}
`,
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "review-flow -- Audit the auth flow",
        root,
      );
      const runParams = record(params);

      assert.deepEqual(
        records(runParams.chain).map(({ agent, task }) => ({ agent, task })),
        [
          { agent: "scout", task: "Scan {task}" },
          { agent: "reviewer", task: "Review {previous}" },
        ],
      );
      assert.equal(runParams.task, "Audit the auth flow");
      assert.equal(runParams.clarify, false);
      assert.equal(runParams.agentScope, "both");
      assert.equal(runParams.async, undefined);
      assert.equal(runParams.context, undefined);
    });
  });

  it("/run-chain launches a saved JSON chain with dynamic fanout", async () => {
    await withTempProject("pi-run-chain-json-dynamic-", async (root) => {
      writeProjectChain(
        root,
        "dynamic-review.chain.json",
        JSON.stringify({
          name: "dynamic-review",
          description: "Dynamic review flow",
          chain: [
            {
              agent: "scout",
              task: "Return targets",
              as: "targets",
              outputSchema: { type: "object" },
            },
            {
              expand: {
                from: { output: "targets", path: "/items" },
                item: "target",
                key: "/path",
                maxItems: 4,
              },
              parallel: {
                agent: "reviewer",
                task: "Review {target.path}",
                outputSchema: { type: "object" },
              },
              collect: { as: "reviews" },
            },
          ],
        }),
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "dynamic-review -- Audit",
        root,
      );
      const runParams = record(params);

      assert.equal(runParams.task, "Audit");
      assert.equal(runParams.clarify, false);
      assert.equal(runParams.agentScope, "both");
      const steps = records(runParams.chain);
      assert.equal(steps[0].agent, "scout");
      assert.deepEqual(steps[1].expand, {
        from: { output: "targets", path: "/items" },
        item: "target",
        key: "/path",
        maxItems: 4,
      });
      assert.deepEqual(steps[1].collect, { as: "reviews" });
    });
  });

  it("/run-chain preserves saved sequential acceptance, cwd, and inherited tasks", async () => {
    await withTempProject("pi-run-chain-acceptance-", async (root) => {
      const acceptance = {
        criteria: [{ id: "verified", must: "Pass the required check" }],
        verify: [{ id: "reject", command: "exit 17" }],
      };
      writeProjectChain(
        root,
        "gated.chain.json",
        JSON.stringify({
          name: "gated",
          description: "Gated review flow",
          chain: [
            { agent: "scout", task: "Gather context" },
            { agent: "reviewer", cwd: "subdir", acceptance },
          ],
        }),
      );

      const { params } = await captureSlashCommandParams("run-chain", "gated -- Inspect", root);
      const step = records(record(params).chain)[1];
      assert.deepEqual(step.acceptance, acceptance);
      assert.equal(step.cwd, "subdir");
      assert.equal(
        validateExecutionInput(
          normalizeSubagentParamsLike(record(params)),
          [makeAgent("scout"), makeAgent("reviewer")],
          { hasChain: true, hasTasks: false, hasSingle: false, allowClarifyTaskPrompt: false },
        ),
        null,
      );
    });
  });

  it("/run-chain launches and completes packaged saved chains by dotted runtime name", async () => {
    await withTempProject("pi-run-chain-packaged-", async (root) => {
      writeProjectChain(
        root,
        "code-analysis.review-flow.chain.md",
        `---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Scan {task}
`,
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "code-analysis.review-flow -- Audit",
        root,
      );
      assert.equal(record(params).task, "Audit");
      assert.deepEqual(
        records(record(params).chain).map(({ agent, task }) => ({ agent, task })),
        [{ agent: "code-analysis.scout", task: "Scan {task}" }],
      );

      await withIsolatedHome(async () => {
        const commands = new Map<string, RegisteredSlashCommand>();
        const pi: ExtensionAPI = {
          ...native.pi,
          events: createEventBus(),
          registerCommand(name, spec) {
            commands.set(name, spec);
          },
          registerShortcut() {
            /* The fixture does not need registerShortcut side effects. */
          },
          sendMessage(_message: unknown) {
            /* The fixture does not need sendMessage side effects. */
          },
        };
        registerSlashCommands(pi, createState(root));
        const registeredRunChainCommand = commands.get("run-chain");
        assertDefined(registeredRunChainCommand);
        const defined26130_0 = registeredRunChainCommand.getArgumentCompletions;
        assertDefined(defined26130_0);
        const completions = await defined26130_0("code-");
        assertDefined(completions);
        assert.deepEqual(
          completions.map((completion) => completion.value),
          ["code-analysis.review-flow"],
        );
      });
    });
  });

  it("/run-chain reports an unknown saved chain without launching", async () => {
    await withTempProject("pi-run-chain-unknown-", async (root) => {
      const { params, notifications } = await captureSlashCommandParams(
        "run-chain",
        "missing -- Do work",
        root,
      );

      assert.equal(params, undefined);
      assert.deepEqual(notifications, ["Unknown chain: missing"]);
    });
  });

  it("/run-chain suggests saved chain names", async () => {
    await withTempProject("pi-run-chain-completions-", async (root) => {
      writeProjectChain(
        root,
        "review-flow.chain.md",
        `---
name: review-flow
description: Review flow
---

## scout

Scan
`,
      );
      writeProjectChain(
        root,
        "release-flow.chain.md",
        `---
name: release-flow
description: Release flow
---

## planner

Plan
`,
      );
      writeProjectChain(
        root,
        "triage.chain.md",
        `---
name: triage
description: Triage flow
---

## scout

Triage
`,
      );

      await withIsolatedHome(async () => {
        const commands = new Map<string, RegisteredSlashCommand>();
        const pi: ExtensionAPI = {
          ...native.pi,
          events: createEventBus(),
          registerCommand(name, spec) {
            commands.set(name, spec);
          },
          registerShortcut() {
            /* The fixture does not need registerShortcut side effects. */
          },
          sendMessage(_message: unknown) {
            /* The fixture does not need sendMessage side effects. */
          },
        };

        registerSlashCommands(pi, createState(root));
        const registeredRunChainCommand = commands.get("run-chain");
        assertDefined(registeredRunChainCommand);
        const defined27927_0 = registeredRunChainCommand.getArgumentCompletions;
        assertDefined(defined27927_0);
        const completions = await defined27927_0("re");
        assertDefined(completions);
        assertDefined(completions);
        assert.deepEqual(completions.map((completion) => completion.value).sort(), [
          "release-flow",
          "review-flow",
        ]);
        assert.deepEqual(completions.map((completion) => completion.label).sort(), [
          "release-flow",
          "review-flow",
        ]);
        const defined28381_0 = registeredRunChainCommand.getArgumentCompletions;
        assertDefined(defined28381_0);
        assert.equal(defined28381_0("review-flow -- "), null);
      });
    });
  });

  it("/run-chain maps --bg to async execution", async () => {
    await withTempProject("pi-run-chain-bg-", async (root) => {
      writeProjectChain(
        root,
        "review-flow.chain.md",
        `---
name: review-flow
description: Review flow
---

## scout

Scan
`,
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "review-flow -- Audit --bg",
        root,
      );

      assert.equal(record(params).async, true);
      assert.equal(record(params).context, undefined);
    });
  });

  it("/run-chain maps --fg to foreground execution", async () => {
    await withTempProject("pi-run-chain-fg-", async (root) => {
      writeProjectChain(
        root,
        "review-flow.chain.md",
        `---
name: review-flow
description: Review flow
---

## scout

Scan
`,
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "review-flow -- Audit --fg",
        root,
      );

      assert.equal(record(params).async, false);
    });
  });

  it("/run-chain rejects conflicting execution flags", async () => {
    await withTempProject("pi-run-chain-mode-conflict-", async (root) => {
      const { params, notifications } = await captureSlashCommandParams(
        "run-chain",
        "review-flow -- Audit --bg --fg",
        root,
      );
      assert.equal(params, undefined);
      assert.deepEqual(notifications, ["Choose only one of --bg or --fg"]);
    });
  });

  it("/run-chain maps --fork to forked context", async () => {
    await withTempProject("pi-run-chain-fork-", async (root) => {
      writeProjectChain(
        root,
        "review-flow.chain.md",
        `---
name: review-flow
description: Review flow
---

## scout

Scan
`,
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "review-flow -- Audit --fork",
        root,
      );

      assert.equal(record(params).context, "fork");
      assert.equal(record(params).async, undefined);
    });
  });

  it("/run-chain prefers a project saved chain over a same-named user chain", async () => {
    await withTempProject("pi-run-chain-priority-", async (root) => {
      writeProjectChain(
        root,
        "review-flow.chain.md",
        `---
name: review-flow
description: Project review flow
---

## scout

Project chain task
`,
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "review-flow -- Shared task",
        root,
        () => {
          const userChainsDir = path.join(os.homedir(), ".pi", "agent", "chains");
          fs.mkdirSync(userChainsDir, { recursive: true });
          fs.writeFileSync(
            path.join(userChainsDir, "review-flow.chain.md"),
            `---
name: review-flow
description: User review flow
---

## scout

User chain task
`,
            "utf-8",
          );
        },
      );

      assert.equal(records(record(params).chain)[0].task, "Project chain task");
    });
  });

  it("/run-chain preserves JSON precedence for duplicate same-scope saved chains", async () => {
    await withTempProject("pi-run-chain-format-priority-", async (root) => {
      writeProjectChain(
        root,
        "review-flow.chain.md",
        `---
name: review-flow
description: Markdown review flow
---

## scout

Markdown chain task
`,
      );
      writeProjectChain(
        root,
        "review-flow.chain.json",
        JSON.stringify({
          name: "review-flow",
          description: "JSON review flow",
          chain: [{ agent: "scout", task: "JSON chain task" }],
        }),
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "review-flow -- Shared task",
        root,
      );
      assert.equal(records(record(params).chain)[0].task, "JSON chain task");
    });
  });

  it("/run-chain resolves saved outputSchema files at the command boundary", async () => {
    await withTempProject("pi-run-chain-schema-", async (root) => {
      const schemasDir = path.join(root, ".pi", "chains", "schemas");
      fs.mkdirSync(schemasDir, { recursive: true });
      fs.writeFileSync(
        path.join(schemasDir, "finding.schema.json"),
        JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }),
        "utf-8",
      );
      writeProjectChain(
        root,
        "schema-flow.chain.md",
        `---
name: schema-flow
description: Schema flow
---

## scout
outputSchema: ./schemas/finding.schema.json

Gather context
`,
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "schema-flow -- Shared task",
        root,
      );

      assert.deepEqual(records(record(params).chain)[0].outputSchema, {
        type: "object",
        properties: { ok: { type: "boolean" } },
      });
    });
  });

  it("/run-chain preserves saved step behavior fields", async () => {
    await withTempProject("pi-run-chain-fields-", async (root) => {
      writeProjectChain(
        root,
        "field-flow.chain.md",
        `---
name: field-flow
description: Field flow
---

## scout
output: context.md
outputMode: file-only
reads: input.md, notes.md
model: openai/gpt-5.5
skills: research, audit
progress: true

Gather context
`,
      );

      const { params } = await captureSlashCommandParams(
        "run-chain",
        "field-flow -- Shared task",
        root,
      );

      assert.deepEqual(array(record(params).chain)[0], {
        agent: "scout",
        task: "Gather context",
        output: "context.md",
        outputMode: "file-only",
        reads: ["input.md", "notes.md"],
        progress: true,
        skill: ["research", "audit"],
        model: "openai/gpt-5.5",
      });
    });
  });
});

describe("subagents-doctor slash command", () => {
  beforeEach(() => {
    clearSlashSnapshots();
  });

  it("routes to the doctor tool action", async () => {
    const { params } = await captureSlashCommandParams("subagents-doctor", "", process.cwd());
    assert.deepEqual(params, { action: "doctor" });
  });

  it("does not register the removed subagents-status overlay command", async () => {
    await withIsolatedHome(async () => {
      const commands = new Map<string, RegisteredSlashCommand>();
      const pi: ExtensionAPI = {
        ...native.pi,
        events: createEventBus(),
        registerCommand(name, spec) {
          commands.set(name, spec);
        },
        registerShortcut() {
          /* The fixture does not need registerShortcut side effects. */
        },
        sendMessage(_message: unknown) {
          /* The fixture does not need sendMessage side effects. */
        },
      };

      registerSlashCommands(pi, createState(process.cwd()));
      assert.equal(commands.has("subagents-status"), false);
    });
  });
});
