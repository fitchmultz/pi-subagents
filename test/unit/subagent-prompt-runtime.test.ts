import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionManager, type BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createNativeSessionFixture } from "../support/native-session.ts";
import { makeMinimalCtx } from "../support/helpers.ts";
import { assertDefined, json, array, records, text } from "../support/assertions.ts";
import registerSubagentPromptRuntime, {
  SUBAGENT_INTERCOM_SESSION_NAME_ENV,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

const envSnapshot = {
  PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
  PI_SUBAGENT_NATIVE_BASELINE_COUNT: process.env.PI_SUBAGENT_NATIVE_BASELINE_COUNT,
  PI_SUBAGENT_INTERCOM_SESSION_NAME: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
};

function promptEvent(): BeforeAgentStartEvent {
  const systemPromptOptions = {
    cwd: "/fixture",
    selectedTools: [],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    skills: [],
    contextFiles: [],
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

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("subagent prompt runtime", () => {
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

  it("sets the child intercom session name from env during agent startup", async () => {
    process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = "subagent-worker-78f659a3";
    const h = await runtime();
    await h.emit("before_agent_start", promptEvent());
    assert.equal(h.pi.getSessionName(), "subagent-worker-78f659a3");
  });
});
