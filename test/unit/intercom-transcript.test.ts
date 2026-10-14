import "../support/isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { readLiveTranscript } from "../../src/pi-intercom/transcript.ts";
import { readSavedTranscript } from "../../src/pi-intercom/saved-transcript.ts";
const packageRoot = fileURLToPath(
  new URL("..", import.meta.resolve("@earendil-works/pi-coding-agent")),
);

test("recent native transcript follows only the active branch, pages and bounds UTF-8 textual output", () => {
  const manager = SessionManager.inMemory("/tmp");
  const root = manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage("abandoned branch"));
  manager.branch(root);
  manager.appendMessage(
    fauxAssistantMessage([
      { type: "thinking", thinking: "private reasoning", thinkingSignature: "opaque" },
      { type: "text", text: "active branch" },
      { type: "toolCall", id: "call", name: "test", arguments: { secret: "opaque arguments" } },
    ]),
  );
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call",
    toolName: "test",
    content: [
      { type: "text", text: "tool output" },
      { type: "image", data: "private image", mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 2,
  });
  manager.appendCustomMessageEntry("visible", "custom output", true);
  manager.appendCustomEntry("state", { secret: "opaque state" });
  const before = JSON.stringify(manager.getEntries());
  const page = readLiveTranscript(manager, { limit: 2 });
  assert.deepEqual(
    page.records.map((entry) => entry.text),
    ["tool output", "custom output"],
  );
  assert.equal(page.truncated, true);
  assert.notEqual(page.cursor, undefined);
  const older = readLiveTranscript(manager, { cursor: page.cursor });
  assert.deepEqual(
    older.records.map((entry) => entry.text),
    ["root", "active branch"],
  );
  assert.equal(older.truncated, false);
  assert.doesNotMatch(JSON.stringify(page) + JSON.stringify(older), /abandoned|private|opaque/);
  assert.equal(JSON.stringify(manager.getEntries()), before);
  manager.appendMessage(fauxAssistantMessage("🌊".repeat(300)));
  assert.throws(() => readLiveTranscript(manager, { cursor: page.cursor }), /branch changed/);
  const bounded = readLiveTranscript(manager, { maxBytes: 257 });
  assert.equal(bounded.bytes, 257);
  assert.equal(bounded.records[0].text, "c");
  assert.equal(bounded.records.at(-1)?.text, "🌊".repeat(64));
  assert.equal(bounded.records.at(-1)?.truncated, true);
  assert.throws(() => readLiveTranscript(manager, { limit: 101 }), /integer/);
});

test("approved saved journal transcript is projected and migration is in-memory, never a read rewrite", async () => {
  const root = mkdtempSync("/tmp/pit-");
  const file = join(root, "legacy.jsonl");
  const lines = [
    {
      type: "session",
      version: 1,
      id: "saved-session",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: root,
    },
    { type: "message", message: { role: "user", content: "legacy user", timestamp: 1 } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "saved answer" },
          { type: "thinking", thinking: "hidden" },
        ],
        provider: "private",
        signature: "private",
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [
          { type: "text", text: "saved tool" },
          { type: "image", data: "secret image" },
        ],
        details: { secret: "private" },
      },
    },
  ];
  writeFileSync(file, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  try {
    const bytes = readFileSync(file);
    const stat = statSync(file);
    const page = await readSavedTranscript(packageRoot, file);
    assert.equal(page.sessionId, "saved-session");
    assert.deepEqual(
      page.records.map((entry) => entry.text),
      ["legacy user", "saved answer", "saved tool"],
    );
    assert.doesNotMatch(JSON.stringify(page), /hidden|private|secret image/);
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(statSync(file).mtimeMs, stat.mtimeMs);
    assert.equal(statSync(file).ctimeMs, stat.ctimeMs);
    const repairedLines = lines.map((entry) => JSON.stringify(entry));
    repairedLines.splice(
      2,
      0,
      '{"type":"message","message":{"role":"assistant","content":"' + "x".repeat(200000),
    );
    const repairedBytes = Buffer.from(`${repairedLines.join("\n")}\n`);
    writeFileSync(file, repairedBytes);
    const recovered = await readSavedTranscript(packageRoot, file);
    assert.deepEqual(
      recovered.records.map((entry) => entry.text),
      ["legacy user", "saved answer", "saved tool"],
    );
    assert.equal(recovered.truncated, false);
    assert.ok(recovered.records.every((entry) => !entry.truncated));
    assert.deepEqual(readFileSync(file), repairedBytes, "native-skippable crash line is read-only");
    const long = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200000) }] },
    });
    const boundedJournal = Buffer.concat([bytes, Buffer.from(`${long}\n`)]);
    writeFileSync(file, boundedJournal);
    const bounded = await readSavedTranscript(packageRoot, file, { limit: 1, maxBytes: 131072 });
    assert.equal(bounded.records[0].text.length, 131072);
    assert.equal(bounded.records[0].truncated, true);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.cursor, undefined);
    await assert.rejects(
      readSavedTranscript(packageRoot, file, { cursor: "legacy-cursor" }),
      /no stable entry IDs/,
    );
    assert.deepEqual(readFileSync(file), boundedJournal);
    const tail = JSON.stringify({
      type: "message",
      message: { role: "user", content: "unpublished" },
    });
    writeFileSync(file, Buffer.concat([bytes, Buffer.from(tail)]));
    assert.doesNotMatch(
      JSON.stringify(await readSavedTranscript(packageRoot, file)),
      /unpublished/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native transcript scan ceiling is explicit and does not offer an unusable cursor", () => {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "outside the recent window", timestamp: 1 });
  for (let index = 0; index < 1025; index += 1) {
    manager.appendCustomEntry("state", { index });
  }
  const page = readLiveTranscript(manager);
  assert.deepEqual(page.records, []);
  assert.equal(page.scanLimitReached, true);
  assert.equal(page.truncated, true);
  assert.equal(page.cursor, undefined);
});
