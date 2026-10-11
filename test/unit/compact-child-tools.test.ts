import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, it } from "node:test";
import { Compile } from "typebox/compile";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { assertDefined, array, record, strings, text, textAt } from "../support/assertions.ts";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord, type UnknownRecord } from "../../src/shared/unknown.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "compact-child-tools-"));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_")) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: root,
  PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"),
  PI_SUBAGENT_CHILD: "1",
  PI_SUBAGENT_FANOUT_CHILD: "1",
  PI_SUBAGENT_DEPTH: "1",
  PI_SUBAGENT_MAX_DEPTH: "2",
});
const { default: register } = await import("../../src/extension/fanout-child.ts");
const { formatRunAction } = await import("../../src/shared/status-format.ts");
const { buildPiArgs } = await import("../../src/runs/shared/pi-args.ts");
const { default: registerPrompt } =
  await import("../../src/runs/shared/subagent-prompt-runtime.ts");
const { OWNED_RUN_ENTRY } = await import("../../src/runs/shared/run-records.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const configPath = path.join(root, "extensions/subagent/config.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
const shutdowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) {
    // Each native extension shuts down before the next fixture can replace shared history resources.
    // oxlint-disable-next-line no-await-in-loop
    await shutdown();
  }
  delete process.env.PI_SUBAGENT_EAGER_TOOL;
});
after(() => {
  process.env = savedEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(
  config: UnknownRecord = {},
  allowed?: readonly string[],
  entries: readonly UnknownRecord[] = [],
) {
  fs.writeFileSync(configPath, JSON.stringify(config));
  const manager = SessionManager.inMemory(root, { id: "child-owner" });
  for (const entry of entries) {
    manager.appendCustomEntry(text(entry.customType), entry.data);
  }
  const native = await createNativeSessionFixture({
    cwd: root,
    agentDir: root,
    sessionManager: manager,
    bindExtensions: false,
    configure(pi) {
      pi.registerTool(createReadToolDefinition(root));
      if (allowed !== undefined) {
        const all = pi.getAllTools.bind(pi),
          set = pi.setActiveTools.bind(pi),
          add = pi.registerTool.bind(pi);
        const scoped: ExtensionAPI = {
          ...pi,
          getAllTools: () =>
            all().filter((tool) => tool.name === "read" || allowed.includes(tool.name)),
          setActiveTools: (names) => {
            set(names.filter((name) => name === "read" || allowed.includes(name)));
          },
          registerTool: (tool) => {
            add({
              ...tool,
              defaultActive: tool.defaultActive !== false && allowed.includes(tool.name),
            });
          },
        };
        register(scoped);
      } else {
        register(pi);
      }
    },
  });
  const { pi } = native;
  const handlers = native.extensions[0].handlers;
  const emit = async (event: string, payload: UnknownRecord = {}) => {
    for (const handler of handlers.get(event) ?? []) {
      // Native handlers compose in registration order and may update selection for the next handler.
      // oxlint-disable-next-line no-await-in-loop
      await handler({ type: event, ...payload }, native.context);
    }
  };
  shutdowns.push(async () => {
    await emit("session_shutdown", { reason: "quit" });
    await native.dispose();
  });
  const tools = {
    get(name: string) {
      const tool = native.session.extensionRunner.getToolDefinition(name);
      assertDefined(tool);
      return tool;
    },
    has(name: string) {
      return native.session.extensionRunner.getToolDefinition(name) !== undefined;
    },
  };
  const call = async (
    name: string,
    params: UnknownRecord = {},
  ): Promise<
    UnknownRecord & { readonly details: UnknownRecord; readonly content: readonly unknown[] }
  > => {
    const value: unknown = await tools
      .get(name)
      .execute(
        "call-" + name,
        params,
        undefined,
        undefined,
        native.session.extensionRunner.createToolContext("call-" + name, undefined),
      );
    const result = record(value);
    return { ...result, details: record(result.details), content: array(result.content) };
  };
  const definitions = () =>
    pi.getAllTools().filter((tool) => pi.getActiveTools().includes(tool.name));
  return { pi, tools, ctx: native.context, handlers, call, emit, definitions };
}

function asyncDescription(value: unknown): string {
  const properties = record(record(record(value).parameters).properties);
  return text(record(properties.async).description);
}

it("starts compact, lazily activates the complete advanced schema, and resets additively", async () => {
  const f = await fixture();
  await f.emit("session_start");
  assert.deepEqual(f.pi.getActiveTools(), ["read", "delegate", "load_subagent"]);
  assert.match(f.tools.get("delegate").description, /Foreground by default/);
  assert.match(asyncDescription(f.tools.get("delegate")), /Foreground by default/);
  assert.match(
    strings(f.tools.get("delegate").promptGuidelines).join("\n"),
    /original parent owns integration/,
  );
  assert.match(
    strings(f.tools.get("delegate").promptGuidelines).join("\n"),
    /maxFinalizationTurns/,
  );
  assert.match(
    strings(f.tools.get("delegate").promptGuidelines).join("\n"),
    /implementation handoffs/,
  );
  assert.match(f.tools.get("load_subagent").description, /get, extend and doctor/);
  assert.notEqual((await f.call("agent_runs", { action: "profiles" })).isError, true);
  await f.call("load_subagent");
  assert.ok(f.pi.getActiveTools().includes("subagent"));
  const advanced = f.tools.get("subagent");
  const schema = Compile(advanced.parameters);
  for (const params of [
    {
      tasks: [
        {
          agent: "probe",
          task: "parallel",
          acceptance: { criteria: ["preserve flexible criteria"] },
        },
      ],
      concurrency: 2,
      worktree: true,
    },
    {
      chain: [
        { agent: "probe", task: "seed", as: "seed", outputSchema: { type: "object" } },
        {
          expand: { from: { output: "seed", path: "/items" }, maxItems: 2 },
          parallel: { agent: "probe", task: "{item}" },
          collect: { as: "results" },
        },
      ],
    },
    { action: "get", chainName: "workflow" },
    { action: "doctor" },
    { action: "extend", id: "run", extendMs: 1000 },
  ]) {
    assert.ok(schema.Check(params), JSON.stringify(params));
  }
  for (const action of ["create", "update", "delete"]) {
    // Validate each forbidden action independently using the same owner state.
    // oxlint-disable-next-line no-await-in-loop
    const blocked = await f.call("subagent", { action, agent: "probe", config: { name: "probe" } });
    assert.equal(blocked.isError, true);
    assert.match(textAt(blocked.content), /not available from child-safe/);
  }
  await f.emit("session_compact");
  assert.ok(
    f.pi.getActiveTools().includes("subagent"),
    "compaction preserves explicit current selection",
  );
  for (const lifecycle of ["session_tree", "session_start"]) {
    f.pi.setActiveTools(["read", "delegate", "load_subagent"]); // Native tree/start supplies the selected loadout.
    // Reset then lazy-load before testing the next lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    await f.emit(lifecycle);
    assert.deepEqual(f.pi.getActiveTools(), ["read", "delegate", "load_subagent"]);
    // The next reset must start from an explicitly expanded tool selection.
    // oxlint-disable-next-line no-await-in-loop
    await f.call("load_subagent");
  }
});

it("restores the old full surface with the flag and honors eager/filtered advanced policies", async () => {
  const legacy = await fixture({ compactChildTools: false });
  await legacy.emit("session_start");
  assert.deepEqual(legacy.pi.getActiveTools(), ["read", "subagent"]);
  assert.equal(legacy.tools.has("load_subagent"), false);
  assert.match(
    formatRunAction("resume", "run", { message: "continue" }, true),
    /^subagent\(\{ action: "resume"/,
  );
  assert.doesNotMatch(formatRunAction("extend", "run", {}, true), /load_subagent/);
  const filtered = await fixture({}, ["subagent"]);
  await filtered.emit("session_start");
  assert.deepEqual(filtered.pi.getActiveTools(), ["read", "subagent"]);
  process.env.PI_SUBAGENT_EAGER_TOOL = "1";
  const eager = await fixture();
  await eager.emit("session_start");
  assert.ok(eager.pi.getActiveTools().includes("subagent"));
  const denied = await fixture({}, ["delegate", "agent_runs", "load_subagent"]);
  await denied.emit("session_start");
  await assert.rejects(() => denied.call("load_subagent"), /full tool is excluded/);
});

it("lists only restored direct-owned runs and preserves scoped exact-ID controls", async () => {
  const run = (runId: string, ownerSessionId: string) => ({
    runId,
    ownerSessionId,
    rootRunId: runId,
    source: "foreground",
    mode: "single",
    cwd: root,
    task: "Check ownership",
    startedAt: 1,
    children: [],
  });
  const f = await fixture(
    {},
    ["delegate", "agent_runs", "load_subagent", "subagent"],
    [
      { type: "custom", customType: OWNED_RUN_ENTRY, data: run("own-a", "child-owner") },
      { type: "custom", customType: OWNED_RUN_ENTRY, data: run("own-b", "child-owner") },
      { type: "custom", customType: OWNED_RUN_ENTRY, data: run("foreign-run", "another-owner") },
    ],
  );
  // Listing before session_start must also restore ownership.
  const listed = await f.call("agent_runs", { action: "list", limit: 1 });
  assert.equal(listed.isError, undefined);
  assert.equal(record(listed.details.runList).total, 2);
  assert.equal(record(listed.details.runList).nextOffset, 1);
  assert.equal(array(listed.details.runs).length, 1);
  assert.doesNotMatch(textAt(listed.content), /foreign-run/);
  assert.match(textAt(listed.content), /Next: agent_runs/);
  const next = await f.call("agent_runs", { action: "list", offset: 1, limit: 1 });
  assert.notEqual(
    record(array(next.details.runs)[0]).runId,
    record(array(listed.details.runs)[0]).runId,
  );
  for (const action of ["inspect", "stop", "nudge"]) {
    // Each authorization result is inspected before issuing the next control request.
    // oxlint-disable-next-line no-await-in-loop
    const denied = await f.call("agent_runs", {
      action,
      id: "foreign-run",
      ...(action === "nudge" ? { message: "stay scoped" } : {}),
    });
    assert.equal(denied.isError, true, action);
  }
  const advancedList = await f.call("subagent", { action: "status" });
  assert.equal(advancedList.isError, true, "legacy global enumeration remains forbidden");
});

it("routes compact validation, worktrees, depth checks, and native error hooks through the child executor", async () => {
  const f = await fixture();
  for (const name of ["delegate", "agent_runs", "subagent"]) {
    // Each tool-name assertion completes against the current hook set before advancing.
    // oxlint-disable-next-line no-await-in-loop
    const patches = await Promise.all(
      (f.handlers.get("tool_result") ?? []).map((handler) =>
        handler({ toolName: name, details: { mode: "single", results: [], isError: true } }, f.ctx),
      ),
    );
    const patched = record(patches.find((value) => isRecord(value) && value.isError === true));
    assert.equal(patched.isError, true);
    assert.equal(record(patched.details).isError, undefined);
  }
  for (const worktree of [false, true]) {
    // Both policies share config/owner storage; finish each launch validation before the next.
    // oxlint-disable-next-line no-await-in-loop
    const missing = await f.call("delegate", {
      agent: "__missing__",
      task: "Check normalization",
      worktree,
      acceptance: {
        criteria: [{ id: "proof", must: "normalize" }],
        verify: [{ id: "check", command: "true", env: [{ name: "A", value: "B" }] }],
      },
    });
    assert.match(textAt(missing.content), /Unknown agent: __missing__/);
    assert.equal(missing.details.mode, worktree ? "parallel" : "single");
  }
  await assert.rejects(
    () => f.call("agent_runs", { action: "continue", id: "run" }),
    /Invalid agent_runs arguments/,
  );
  process.env.PI_SUBAGENT_MAX_DEPTH = "1";
  try {
    const blocked = await f.call("delegate", { agent: "worker", task: "Must not launch" });
    assert.match(textAt(blocked.content), /Nested subagent call blocked/);
  } finally {
    process.env.PI_SUBAGENT_MAX_DEPTH = "2";
  }
  assert.match(
    formatRunAction("resume", "run", { message: "continue" }, true),
    /^agent_runs\(\{ action: "continue"/,
  );
  assert.match(
    formatRunAction("extend", "run", { extendMs: 1000 }, true),
    /^load_subagent\(\{\}\), then subagent/,
  );
  const background = await fixture({ asyncByDefault: true });
  assert.match(asyncDescription(background.tools.get("delegate")), /Background by default/);
});

it("keeps launch allowlists and prompt discovery aligned with the reversible flag", async () => {
  const base = {
    baseArgs: ["-p"],
    task: "Check",
    sessionEnabled: false,
    inheritProjectContext: false,
    inheritSkills: false,
  };
  for (const compactChildTools of [false, true]) {
    // Each launch policy is installed before inspecting its argument/environment boundary.
    // oxlint-disable-next-line no-await-in-loop
    await fixture({ compactChildTools });
    process.env.PI_SUBAGENT_EAGER_TOOL = "1";
    const launched = buildPiArgs({ ...base, allowSubagents: true, tools: ["read"] });
    assert.equal(
      launched.args[launched.args.indexOf("--tools") + 1],
      compactChildTools ? "read,subagent,delegate,agent_runs,load_subagent" : "read,subagent",
    );
    assert.equal(
      launched.env.PI_SUBAGENT_EAGER_TOOL,
      undefined,
      "ordinary profiles do not inherit an ancestor's eager policy",
    );
    const explicit = buildPiArgs({ ...base, tools: ["subagent", "read"] });
    assert.equal(explicit.env.PI_SUBAGENT_EAGER_TOOL, "1");
    for (const name of ["delegate", "agent_runs", "load_subagent"]) {
      assert.equal(
        buildPiArgs({ ...base, tools: [name] }).env.PI_SUBAGENT_FANOUT_CHILD,
        "0",
        "compact names alone do not grant delegation permission",
      );
    }
    // The current flag must govern this native registration, before the next loop changes it.
    // oxlint-disable-next-line no-await-in-loop
    const prompt = await createNativeSessionFixture({
      cwd: root,
      agentDir: root,
      configure: registerPrompt,
    });
    shutdowns.push(prompt.dispose);
    const options = { cwd: root, sections: {}, skills: [] };
    // Prompt sections must be inspected before switching the shared launch policy.
    // oxlint-disable-next-line no-await-in-loop
    const emitted = await prompt.session.extensionRunner.emitBeforeAgentStart(
      "Parent policy",
      undefined,
      options,
    );
    const role = emitted.systemPromptOptions.sections.subagent_role;
    assert.match(
      role,
      compactChildTools
        ? /agent_runs.*profiles.*delegate.*load_subagent/
        : /subagent\(\{action:'list'\}\)/,
    );
    if (!compactChildTools) {
      assert.doesNotMatch(role, /agent_runs|load_subagent/);
    }
  }
});

it("measures serialized active startup definitions rather than tokens", async () => {
  const legacy = await fixture({ compactChildTools: false });
  await legacy.emit("session_start");
  const beforeChars = JSON.stringify(legacy.definitions()).length;
  const compact = await fixture();
  await compact.emit("session_start");
  const afterChars = JSON.stringify(compact.definitions()).length;
  assert.ok(
    afterChars < beforeChars * 0.5,
    `${beforeChars} -> ${afterChars} serialized characters`,
  );
  console.log(
    JSON.stringify({
      measurement:
        "serialized active child delegation definitions (name, description, parameters, promptSnippet, promptGuidelines); characters, not tokens",
      beforeChars,
      afterChars,
      savedChars: beforeChars - afterChars,
    }),
  );
});
