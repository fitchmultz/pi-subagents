import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { childUsage } from "../../src/agent/usage.ts";
import { usageLaunch } from "../support/agent-launch.ts";

const usage = {
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  cacheWrite1h: 15,
  reasoning: 5,
  totalTokens: 100,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

test("native accounting excludes inherited entries and checkpoints and includes tool/summary/usage entries", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  const assistant = (id: string, checkpoint = false) => ({
    type: "message",
    id,
    checkpoint,
    message: {
      role: "assistant",
      provider: "provider",
      model: "requested",
      responseModel: "actual",
      usage,
    },
  });
  fs.writeFileSync(
    file,
    [
      { type: "session", id: "child" },
      assistant("inherited"),
      assistant("first"),
      assistant("checkpoint-copy", true),
      { type: "message", id: "nested", message: { role: "toolResult", usage } },
      { type: "compaction", id: "summary", usage },
      { type: "branch_summary", id: "branch", usage },
      { type: "usage", id: "native-usage", provider: "other", model: "small", usage },
      assistant("review"),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const contributions = childUsage(usageLaunch(file), new Set(["inherited"]), "review");
  assert.deepEqual(
    contributions.map((part) => part.usage),
    Array.from({ length: 6 }, () => usage),
    "each native entry keeps its exact usage, including optional subset counters",
  );
  assert.deepEqual(
    contributions.map((part) => part.id),
    [
      "child:first",
      "child:nested",
      "child:summary",
      "child:branch",
      "child:native-usage",
      "child:review",
    ],
  );
  assert.equal(contributions[0].model, "actual");
  assert.deepEqual(
    [contributions[1].provider, contributions[1].model],
    ["p", "selected"],
    "tool usage has the frozen launch attribution",
  );
  assert.deepEqual(contributions[4], {
    id: "child:native-usage",
    provider: "other",
    model: "small",
    usage,
  });
  assert.deepEqual(
    childUsage(
      usageLaunch(file),
      new Set(["inherited", "first", "nested", "summary", "branch", "native-usage", "review"]),
    ),
    [],
  );
});

test("missing, foreign and malformed journals cannot authorize native accounting", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  assert.throws(() => childUsage(usageLaunch(file), new Set()), /ENOENT/);
  fs.writeFileSync(file, JSON.stringify({ type: "session", id: "foreign" }) + "\n");
  assert.throws(() => childUsage(usageLaunch(file), new Set()), /Foreign native usage journal/);
  fs.writeFileSync(file, "not JSON\n");
  assert.throws(() => childUsage(usageLaunch(file), new Set()), SyntaxError);
});

test("new assistant/native usage requires complete billing evidence; tool/summary usage is optional and inherited work is excluded", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-usage-required-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  const write = (entries: readonly object[]) =>
    fs.writeFileSync(
      file,
      [{ type: "session", id: "child" }, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  for (const entry of [
    { type: "message", id: "required", message: { role: "assistant" } },
    { type: "usage", id: "required" },
  ]) {
    write([entry]);
    assert.throws(
      () => childUsage(usageLaunch(file), new Set()),
      /Required native usage is unavailable/,
    );
    assert.deepEqual(childUsage(usageLaunch(file), new Set(["required"])), []);
  }
  write([
    { type: "message", id: "tool", message: { role: "toolResult" } },
    { type: "compaction", id: "summary" },
  ]);
  assert.deepEqual(childUsage(usageLaunch(file), new Set()), []);
});
