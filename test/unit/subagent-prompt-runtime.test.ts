import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  SessionManager,
  type BeforeAgentStartEvent,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { makeMinimalCtx } from "../support/helpers.ts";
import { assertDefined, json, array, records, text } from "../support/assertions.ts";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "../../src/runs/shared/structured-output.ts";
import registerSubagentPromptRuntime, {
  CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
  CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
  SUBAGENT_INTERCOM_SESSION_NAME_ENV,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

const envSnapshot = {
  PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
  PI_SUBAGENT_NATIVE_BASELINE_COUNT: process.env.PI_SUBAGENT_NATIVE_BASELINE_COUNT,
  PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
  PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
  PI_SUBAGENT_INTERCOM_SESSION_NAME: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
  PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
  PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE,
  PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA,
};

function skill(name: string): Skill {
  return {
    name,
    description: name,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    disableModelInvocation: false,
    sourceInfo: {
      path: `/skills/${name}/SKILL.md`,
      source: "fixture",
      scope: "user",
      origin: "top-level",
    },
  };
}

function promptEvent(): BeforeAgentStartEvent {
  const systemPromptOptions = {
    cwd: "/fixture",
    selectedTools: [],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    customPrompt: "Selected replacement",
    appendSystemPrompt: '<skill name="explicit">Selected instructions</skill>',
    sections: {},
    skills: [skill("safe-bash"), skill("pi-subagents")],
    contextFiles: [{ path: "/repo/AGENTS.md", content: "Selected project policy" }],
  };
  return {
    type: "before_agent_start",
    prompt: "Assigned task",
    systemPrompt: "Opaque prompt is never parsed",
    systemPromptOptions,
  };
}

const disposals: Array<() => Promise<void>> = [];
async function runtime() {
  const native = await createNativeSessionFixture({
    cwd: "/fixture",
    agentDir: os.tmpdir(),
    configure: registerSubagentPromptRuntime,
    bindExtensions: false,
  });
  disposals.push(native.dispose);
  const emit = async (name: string, event: unknown, ctx: unknown = native.context) => {
    const handler = native.extensions[0].handlers.get(name)?.at(-1);
    assertDefined(handler);
    return await handler(event, ctx);
  };
  return { ...native, emit };
}

async function registerPromptHandler() {
  const h = await runtime();
  return async (event: unknown) => await h.emit("before_agent_start", event);
}

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_NATIVE_BASELINE_COUNT"] as const) {
    if (envSnapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envSnapshot[key];
    }
  }
  if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined) {
    delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
  } else {
    process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT =
      envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
  }
  if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined) {
    delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
  } else {
    process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
  }
  if (envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME === undefined) {
    delete process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME;
  } else {
    process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME = envSnapshot.PI_SUBAGENT_INTERCOM_SESSION_NAME;
  }
  if (envSnapshot.PI_SUBAGENT_FANOUT_CHILD === undefined) {
    delete process.env.PI_SUBAGENT_FANOUT_CHILD;
  } else {
    process.env.PI_SUBAGENT_FANOUT_CHILD = envSnapshot.PI_SUBAGENT_FANOUT_CHILD;
  }
  if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE === undefined) {
    delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
  } else {
    process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
  }
  if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA === undefined) {
    delete process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
  } else {
    process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
  }
});

describe("subagent prompt runtime", () => {
  it("reconciles physical batches, off-branch appends, native replacement and truncation with public entry APIs", async () => {
    const { SessionEntryCursor } = await import("../../src/shared/session-entries.ts");
    const entry = (id: string, parentId: string | null, sequence: number) => ({
      type: "custom" as const,
      customType: "fixture",
      id,
      parentId,
      sequence,
      timestamp: "2026-01-01T00:00:00Z",
      data: {},
    });
    let entries = [entry("root", null, 0)],
      leaf = "root",
      scans = 0;
    const source = {
      getSessionId: () => "fixture",
      getSessionFile: () => "/fixture.jsonl",
      getEntries: () => {
        scans++;
        return entries;
      },
      getLeafId: () => leaf,
      getEntryCount: () => entries.length,
      getEntry: (id: string) => entries.find((item) => item.id === id),
    };
    const cursor = new SessionEntryCursor();
    assert.equal(cursor.read(source).reset, true);
    entries.push(entry("first", "root", 1), entry("second", "first", 2));
    leaf = "second";
    assert.deepEqual(
      cursor.read(source).entries.map(({ id }) => id),
      ["first", "second"],
    );
    assert.equal(scans, 1, "append-only batches do not rescan existing entries");
    entries.push(entry("abandoned", "root", 3), entry("active", "second", 4));
    leaf = "active";
    assert.deepEqual(
      cursor.read(source).entries.map(({ id }) => id),
      ["abandoned", "active"],
    );
    assert.equal(scans, 2, "active-branch links alone must not hide a physical suffix");
    entries = entries.map((item) => ({ ...item }));
    const replaced = cursor.read(source);
    assert.equal(replaced.reset, true, "native reload replaces references even when IDs survive");
    assert.equal(replaced.entries.length, 5);
    entries = entries.slice(0, 1);
    leaf = "root";
    assert.equal(cursor.read(source).reset, true);
    const portable = { getSessionId: () => "fixture", getEntries: () => entries };
    assert.equal(cursor.read(portable).reset, true);
    entries.push(entry("portable", "root", 1));
    assert.deepEqual(
      cursor.read(portable).entries.map(({ id }) => id),
      ["portable"],
    );
    assert.deepEqual(cursor.read(portable).entries, []);
    const transient = { ...source, getSessionFile: (): string | undefined => undefined };
    assert.equal(cursor.read(transient).reset, true);
    assert.deepEqual(cursor.read(transient).entries, []);
  });

  it("observes append-only native history with work proportional to new entries", async (t) => {
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_NATIVE_BASELINE_COUNT = "4000";
    const manager = SessionManager.inMemory("/fixture");
    for (let index = 0; index < 4000; index++) {
      manager.appendCustomEntry("baseline", index);
    }
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "native-observation-")),
      "session.jsonl",
    );
    fs.writeFileSync(file, "");
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    let visits = 0,
      lookups = 0;

    const h = await runtime();
    const emitted: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: unknown) => {
      emitted.push(text(chunk));
      return true;
    });
    const ctx = makeMinimalCtx("/fixture", {
      model: { ...fauxProvider().getModel(), provider: "fixture", id: "faux" },
    });
    const entryLookup = manager.getEntry.bind(manager),
      entryScan = manager.getEntries.bind(manager);
    manager.getSessionFile = () => file;
    manager.getEntry = (id) => {
      visits++;
      lookups++;
      return entryLookup(id);
    };
    manager.getEntries = () => {
      const values = entryScan();
      visits += values.length;
      return values;
    };
    const observed = { ...ctx, sessionManager: manager };
    await h.emit("session_start", { type: "session_start" }, observed);
    assert.ok(
      lookups < 10,
      `startup must use bulk references, not one filesystem-refreshing lookup per historical entry: ${lookups}`,
    );
    const ids: string[] = [];
    for (let index = 0; index < 2000; index++) {
      ids.push(manager.appendMessage({ role: "user", content: `New ${index}`, timestamp: index }));
      // Native message publication is observed before the next turn boundary.
      // oxlint-disable-next-line no-await-in-loop
      await h.emit("message_end", { type: "message_end", message: { role: "user" } }, observed);
      // Observe this persisted turn before appending another message to the same journal.
      // oxlint-disable-next-line no-await-in-loop
      await h.emit("turn_end", { type: "turn_end" }, observed);
    }
    await h.emit("agent_settled", { type: "agent_settled" }, observed);
    t.mock.restoreAll();
    const reports = emitted.map(json);
    assert.equal(reports[0].type, "subagent.native_baseline");
    assert.equal(array(reports[0].entryIds).length, 4000);
    assert.deepEqual(
      reports.slice(1, -1).map((report) => records(report.entries).map((entry) => entry.id)),
      ids.map((id) => [id]),
    );
    const terminal = reports.at(-1);
    assertDefined(terminal);
    assert.deepEqual(terminal.entries, []);
    assert.equal(terminal.messageCount, 2000);
    assert.deepEqual(terminal.configuration, { model: "fixture/faux", thinking: "off" });
    t.diagnostic(`4000 inherited + 2000 new entries: ${visits} native entry visits`);
    assert.ok(
      visits < 20_000,
      `native entry visits must not rescan the baseline on every turn: ${visits}`,
    );
  });

  it("retains initial in-memory entries, off-branch appends, and replacement entries", async (t) => {
    process.env.PI_SUBAGENT_CHILD = "1";
    const manager = SessionManager.inMemory("/fixture");
    const root = manager.appendCustomEntry("root", {});
    const h = await runtime();
    const emitted: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: unknown) => {
      emitted.push(text(chunk));
      return true;
    });
    let observed = makeMinimalCtx("/fixture", { sessionManager: manager });
    await h.emit("session_start", { type: "session_start" }, observed);
    await h.emit("turn_end", { type: "turn_end" }, observed);
    const first = manager.appendCustomEntry("first", {});
    await h.emit("turn_end", { type: "turn_end" }, observed);
    manager.branch(root);
    const abandoned = manager.appendCustomEntry("abandoned", {});
    manager.branch(first);
    const active = manager.appendCustomEntry("active", {});
    await h.emit("turn_end", { type: "turn_end" }, observed);
    const replacementManager = SessionManager.inMemory("/fixture");
    observed = makeMinimalCtx("/fixture", { sessionManager: replacementManager });
    const replacement = replacementManager.appendCustomEntry("replacement", {});
    await h.emit("session_start", { type: "session_start" }, observed);
    await h.emit("turn_end", { type: "turn_end" }, observed);
    t.mock.restoreAll();
    assert.deepEqual(
      emitted.map((line) => records(json(line).entries).map((entry) => entry.id)),
      [[root], [first], [abandoned, active], [replacement]],
    );
  });

  it("registered structured_output tool accepts valid schema output and writes the capture file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-runtime-"));
    try {
      const schemaPath = path.join(dir, "schema.json");
      const outputPath = path.join(dir, "output.json");
      fs.writeFileSync(
        schemaPath,
        JSON.stringify({
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        }),
        "utf-8",
      );
      process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
      process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
      const h = await runtime();
      const tool = h.session.extensionRunner.getToolDefinition("structured_output");
      assertDefined(tool);
      const result = await tool.execute(
        "tool-1",
        { value: { ok: true } },
        undefined,
        undefined,
        h.session.extensionRunner.createToolContext("tool-1", undefined),
      );
      assert.equal(result.terminate, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), { ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds child sections without reparsing selected skills, project policy, or replacement prompts", async () => {
    process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
    process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "0";
    const event = promptEvent();
    const run = await registerPromptHandler();
    assert.equal(await run(event), undefined);
    assert.equal(
      event.systemPromptOptions.sections.subagent_role,
      CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
    );
    assert.equal(event.systemPromptOptions.forceSystemPrompt, undefined);
    assert.equal(event.systemPromptOptions.customPrompt, "Selected replacement");
    assert.equal(
      event.systemPromptOptions.appendSystemPrompt,
      '<skill name="explicit">Selected instructions</skill>',
    );
    assert.deepEqual(event.systemPromptOptions.contextFiles, [
      { path: "/repo/AGENTS.md", content: "Selected project policy" },
    ]);
    assert.deepEqual(event.systemPromptOptions.skills, [skill("safe-bash")]);
  });

  it("replaces only its structured boundary when switching fanout policy", async () => {
    const run = await registerPromptHandler();
    const event = promptEvent();
    for (const allowed of [false, true, false]) {
      process.env[SUBAGENT_FANOUT_CHILD_ENV] = allowed ? "1" : "0";
      // Inspect this policy's projection before replacing the shared environment flag.
      // oxlint-disable-next-line no-await-in-loop
      await run(event);
      if (allowed) {
        assert.ok(
          event.systemPromptOptions.sections.subagent_role.startsWith(
            CHILD_FANOUT_BOUNDARY_INSTRUCTIONS + "\n",
          ),
        );
        assert.match(
          event.systemPromptOptions.sections.subagent_role,
          /agent_runs.*profiles.*delegate.*load_subagent/,
        );
      } else {
        assert.equal(
          event.systemPromptOptions.sections.subagent_role,
          CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
        );
      }
      if (allowed) {
        assert.match(
          event.systemPromptOptions.sections.subagent_role,
          /useful helper work within that task/,
        );
        assert.match(
          event.systemPromptOptions.sections.subagent_role,
          /original parent owns integration/,
        );
        assert.doesNotMatch(
          event.systemPromptOptions.sections.subagent_role,
          /only for the fanout work explicitly requested/,
        );
      }
      assert.equal(event.systemPromptOptions.forceSystemPrompt, undefined);
    }
  });

  it("preserves an earlier opaque full override and makes the child boundary visible", async () => {
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "0";
    const event = promptEvent();
    event.systemPromptOptions.forceSystemPrompt = "EXACT OVERRIDE";
    const run = await registerPromptHandler();
    await run(event);
    assert.equal(
      event.systemPromptOptions.forceSystemPrompt,
      `EXACT OVERRIDE\n\n<subagent_role>\n${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}\n</subagent_role>`,
    );
  });

  it("sets the child intercom session name from env during agent startup", async () => {
    process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";
    const h = await runtime();
    await h.emit("before_agent_start", promptEvent());
    assert.equal(h.pi.getSessionName(), "subagent-worker-78f659a3");
  });

  it("filters parent-only artifacts from polluted fork context while preserving ordinary history", async () => {
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "0";
    const h = await runtime();

    const priorParentTurn = {
      role: "user",
      content: "Earlier we said planner → worker → reviewers → worker.",
    };
    const currentTask = { role: "user", content: "Now implement only the assigned fix." };
    const instruction = {
      role: "custom",
      customType: "subagent-orchestration-instructions",
      content: "Subagent orchestration is enabled.",
    };
    const slashResult = {
      role: "custom",
      customType: "subagent-slash-result",
      content: "## Orchestration",
    };
    const notify = {
      role: "custom",
      customType: "subagent-notify",
      content: "Background task completed",
    };
    const control = {
      role: "custom",
      customType: "subagent_control_notice",
      content: "needs attention",
    };
    const callsAndResults = ["subagent", "delegate", "agent_runs", "load_subagent"].flatMap(
      (name) => [
        {
          role: "assistant",
          content: [{ type: "toolCall", name, id: `${name}-call`, arguments: {} }],
        },
        { role: "toolResult", toolName: name, toolCallId: `${name}-call`, content: "result" },
      ],
    );
    const readResult = { role: "toolResult", toolName: "read", content: "file contents" };
    const mixedAssistant = {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect the repo." },
        { type: "toolCall", name: "subagent", arguments: { agent: "worker" } },
        { type: "toolCall", name: "read", arguments: { path: "README.md" } },
      ],
    };
    const otherCustom = { role: "custom", customType: "other", content: "keep" };
    const messages = [
      priorParentTurn,
      instruction,
      slashResult,
      notify,
      control,
      ...callsAndResults,
      readResult,
      mixedAssistant,
      otherCustom,
      currentTask,
    ];
    const saved = structuredClone(messages);
    assert.deepEqual(await h.emit("context", { type: "context", messages }), {
      messages: [
        priorParentTurn,
        readResult,
        { ...mixedAssistant, content: [mixedAssistant.content[0], mixedAssistant.content[2]] },
        otherCustom,
        currentTask,
      ],
    });
    process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
    assert.deepEqual(await h.emit("context", { type: "context", messages }), {
      messages: [
        priorParentTurn,
        ...callsAndResults,
        readResult,
        mixedAssistant,
        otherCustom,
        currentTask,
      ],
    });
    assert.deepEqual(messages, saved, "context projection never mutates the saved history");
  });

  it("does not rewrite child context when no parent-only artifacts are present", async () => {
    const h = await runtime();

    const messages = [
      { role: "user", content: "Task" },
      { role: "toolResult", toolName: "read", content: "file" },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", input: { path: "README.md" } }],
      },
    ];

    assert.equal(await h.emit("context", { type: "context", messages }), undefined);
  });
});
