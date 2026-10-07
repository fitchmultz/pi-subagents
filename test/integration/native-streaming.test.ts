import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeSessionFixture, makeAgent } from "../support/helpers.ts";
import { Type } from "typebox";
import { Assert } from "typebox/value";
import { readJson, assertDefined } from "../support/assertions.ts";

const root = fs.mkdtempSync(
  path.join(process.env.PI_AGENT_VIEW_EVIDENCE_DIR ?? os.tmpdir(), "native-streaming-"),
);
const fixture = fileURLToPath(new URL("../fixtures/native-feedback-child.mjs", import.meta.url));
const env = { ...process.env };
after(() => {
  process.env = env;
});
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_")) {
    delete process.env[key];
  }
}
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.PI_SUBAGENT_TEMP_ROOT = path.join(root, "pi-subagents-runtime");
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "pi"),
  `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
  { mode: 0o700 },
);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.PI_FEEDBACK_SCENARIO = "streaming";
const { executeAsyncSingle } = await import("../../src/runs/background/async-execution.ts");
const { saveQuestionOwner } = await import("../../src/runs/shared/supervisor-questions.ts");
const { RESULTS_DIR } = await import("../../src/shared/types.ts");
async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < end);
    // Observe native file publication; releasing the child before this would hide the streaming boundary.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
}

test("real native JSON deltas produce readable pre-end text in owner status", async (t) => {
  const id = "stream-bg",
    cwd = path.join(root, id),
    release = path.join(cwd, "release");
  fs.mkdirSync(cwd);
  process.env.PI_FEEDBACK_RELEASE_FILE = release;
  saveQuestionOwner(id, "fixture-owner");
  const agent = makeAgent("worker", {
    model: "feedback-fixture/faux-1",
    extensions: [],
  });
  const receipt = () => {
    const value = readJson(`${release}.json`);
    Assert(
      Type.Object({
        events: Type.Array(
          Type.Object({ type: Type.String(), role: Type.Optional(Type.String()) }),
        ),
      }),
      value,
    );
    return value;
  };
  const native = await createNativeSessionFixture({ cwd, agentDir: path.join(cwd, "agent") });
  const texts: string[] = [];
  t.after(async () => {
    fs.writeFileSync(release, "released");
    await until(() => fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)));
    await native.dispose();
  });
  {
    const started = executeAsyncSingle(id, {
      agent: "worker",
      task: "Stream both blocks",
      agentConfig: agent,
      output: false,
      ctx: { pi: native.pi, cwd, currentSessionId: "fixture-owner" },
      sessionFile: path.join(cwd, "session.jsonl"),
      shareEnabled: false,
      maxSubagentDepth: 1,
    });
    assertDefined(started.details.asyncDir);
    const statusPath = path.join(started.details.asyncDir, "status.json");
    await until(() => {
      if (!fs.existsSync(statusPath)) {
        return false;
      }
      const status = readJson(statusPath);
      Assert(
        Type.Object({
          steps: Type.Optional(
            Type.Array(Type.Object({ streamingText: Type.Optional(Type.String()) })),
          ),
        }),
        status,
      );
      const text = status.steps?.[0]?.streamingText;
      if (text !== undefined && text.length > 0) {
        texts.push(text);
      }
      return text?.includes("Second live text") === true;
    });
  }
  assert.ok(receipt().events.some((event) => event.type === "message_update"));
  assert.equal(
    receipt().events.some((event) => event.type === "message_end" && event.role === "assistant"),
    false,
    "the text is visible before the authoritative final message",
  );
  assert.ok(
    texts.some((text) => text.includes("First live text block.\n\nSecond live text")),
    "multiple native text blocks must remain readable",
  );
  fs.writeFileSync(release, "released");
  await until(() => fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)));
  {
    const result = readJson(path.join(RESULTS_DIR, `${id}.json`));
    Assert(Type.Object({ success: Type.Boolean() }), result);
    assert.equal(result.success, true);
  }
});
