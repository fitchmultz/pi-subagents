import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { childUsage, UsageIndex } from "../../src/agent/usage.ts";
import { usageLaunch } from "../support/agent-launch.ts";
import { observeReads } from "../support/runtime-fs.ts";

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

const header = (version?: number) =>
  JSON.stringify({ type: "session", version, id: "child" }) + "\n";
const turn = (id: string, input: number) =>
  JSON.stringify({
    type: "message",
    id,
    message: { role: "assistant", provider: "p", model: "m", usage: { ...usage, input } },
  }) + "\n";
/**
 * One resident index over `file`, reporting each read's contributed inputs and the journal byte
 * ranges it consumed. Contiguous reads coalesce, so the syscall partition is not observed.
 */
function residentIndex(t: TestContext, file: string) {
  const index = new UsageIndex();
  const ranges: [start: number, end: number][] = [];
  let interference: (() => void) | undefined;
  observeReads(t, ({ position, count }) => {
    const start = Number(position);
    const last = ranges.at(-1);
    if (last?.[1] === start) {
      last[1] += count;
    } else {
      ranges.push([start, start + count]);
    }
    const interfere = interference;
    interference = undefined;
    interfere?.();
  });
  return (baseline: readonly string[], terminal?: string, whileReading?: () => void) => {
    ranges.length = 0;
    interference = whileReading;
    const inputs = index
      .read(usageLaunch(file), new Set(baseline), terminal)
      .map((part) => [part.id, part.usage.input]);
    return { inputs, ranges: ranges.map(([start, end]) => [start, end]) };
  };
}

test("a resident usage index parses only appended native records and keeps terminal, baseline and validation semantics", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-usage-index-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  const read = residentIndex(t, file);
  const size = () => fs.statSync(file).size;
  fs.writeFileSync(file, header(3) + turn("a", 1));
  assert.deepEqual(read([], "a"), {
    inputs: [["child:a", 1]],
    ranges: [[0, size()]],
  });
  let boundary = size();
  fs.appendFileSync(file, turn("b", 2));
  assert.deepEqual(
    read(["a"], "b"),
    { inputs: [["child:b", 2]], ranges: [[boundary, size()]] },
    "a continuation parses only the records appended after the retained LF boundary",
  );
  assert.deepEqual(
    read([], "b"),
    {
      inputs: [
        ["child:a", 1],
        ["child:b", 2],
      ],
      ranges: [],
    },
    "baselines and terminals apply to retained records without rereading them",
  );
  fs.appendFileSync(file, "not JSON\n");
  assert.deepEqual(
    read(["a"], "b"),
    { inputs: [["child:b", 2]], ranges: [] },
    "a predecessor's terminal still ends its accounting before later bytes",
  );
  fs.appendFileSync(file, turn("c", 3));
  assert.throws(
    () => read(["a", "b"], "c"),
    SyntaxError,
    "a successor validates every record it newly requests",
  );
  fs.writeFileSync(file, header(3) + turn("a", 1) + turn("b", 2));
  assert.deepEqual(read(["a"], "b").inputs, [["child:b", 2]]);
  fs.appendFileSync(file, turn("c", 3));
  assert.throws(
    () => read(["a", "b"], "c", () => fs.appendFileSync(file, turn("late", 4))),
    /Native usage journal changed while reading/,
  );
  assert.deepEqual(
    read(["a", "b"], "late"),
    {
      inputs: [
        ["child:c", 3],
        ["child:late", 4],
      ],
      ranges: [[0, size()]],
    },
    "a failed read leaves no retained records",
  );
  boundary = size();
  fs.appendFileSync(file, turn("d", 5).slice(0, -1));
  assert.deepEqual(
    read(["a", "b", "c", "late"]),
    { inputs: [], ranges: [[boundary, size()]] },
    "an unterminated record stays outside the retained LF boundary",
  );
  fs.appendFileSync(file, "\n");
  assert.deepEqual(read(["a", "b", "c", "late"], "d"), {
    inputs: [["child:d", 5]],
    ranges: [[boundary, size()]],
  });
});

test("a resident usage index rebuilds from byte 0 after same-size edits, shrink, inode replacement and native migration", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-usage-rebuild-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  const read = residentIndex(t, file);
  const full = () => [[0, fs.statSync(file).size]];
  fs.writeFileSync(file, header(3) + turn("a", 1) + turn("b", 2));
  assert.deepEqual(read([], "b").ranges, full());
  assert.equal(turn("a", 5).length, turn("a", 1).length);
  const before = fs.statSync(file);
  fs.writeFileSync(file, header(3) + turn("a", 5) + turn("b", 2));
  // Coarse filesystem clocks can repeat a timestamp; make the changed stamp explicit.
  fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 1000));
  assert.deepEqual(read([], "b"), {
    inputs: [
      ["child:a", 5],
      ["child:b", 2],
    ],
    ranges: full(),
  });
  fs.truncateSync(file, Buffer.byteLength(header(3) + turn("a", 5)));
  assert.deepEqual(read([], "a"), { inputs: [["child:a", 5]], ranges: full() });
  fs.writeFileSync(file + ".next", header(3) + turn("a", 5) + turn("c", 3));
  fs.renameSync(file + ".next", file);
  assert.deepEqual(read(["a"], "c"), { inputs: [["child:c", 3]], ranges: full() });
  fs.writeFileSync(file + ".next", header(1) + turn("legacy", 1));
  fs.renameSync(file + ".next", file);
  assert.deepEqual(read([], "legacy").inputs, [["child:legacy", 1]], "warm the legacy prefix");
  const migrated = SessionManager.open(file);
  const [paid] = migrated.getEntries();
  assert.notEqual(paid.id, "legacy", "native migration publishes new entry IDs");
  const next = migrated.appendMessage({
    role: "assistant",
    content: [],
    api: "faux",
    provider: "p",
    model: "m",
    usage: { ...usage, input: 2 },
    stopReason: "stop",
    timestamp: 2,
  });
  assert.deepEqual(
    read([], next).inputs,
    [
      [`child:${paid.id}`, 1],
      [`child:${next}`, 2],
    ],
    "the resident index bills the native-published IDs, not its obsolete cached ID",
  );
});
