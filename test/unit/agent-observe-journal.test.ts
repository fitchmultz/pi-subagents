import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ConversationJournal } from "../../src/agent/journal-tail.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observe-journal-"));
  const file = path.join(root, "child.jsonl");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "session", id: "child-session", version: 3 })}\n`,
  );
  return { root, file };
}
function entry(id: string, parentId: string | null, message: unknown): string {
  return `${JSON.stringify({ type: "message", id, parentId, message })}\n`;
}

test("selected native conversation indexes only published appends and retains branch ancestry", async () => {
  const { root, file } = fixture();
  try {
    fs.appendFileSync(
      file,
      entry("a", null, {
        role: "assistant",
        content: [{ type: "text", text: "first\nsecond 雪😀" }],
      }),
    );
    const journal = new ConversationJournal(file, "child-session");
    const pending = entry("b", "a", {
      role: "toolResult",
      content: [{ type: "text", text: "published result" }],
    });
    fs.appendFileSync(file, pending.slice(0, -1));
    journal.native.refresh();
    assert.deepEqual(
      journal.entries().map((record) => record.value.id),
      ["a"],
    );
    assert.deepEqual((await journal.page(journal.entries()[0])).message.content, [
      { type: "text", text: "first\nsecond 雪😀" },
    ]);
    fs.appendFileSync(file, "\n");
    journal.native.refresh();
    assert.deepEqual(
      journal.entries("b").map((record) => record.value.id),
      ["a", "b"],
    );
    assert.equal(journal.native.refresh(), false, "unchanged index does not replay a publication");
    fs.appendFileSync(file, entry("branch", "a", { role: "assistant", content: "other branch" }));
    journal.native.refresh();
    assert.deepEqual(
      journal.entries("branch").map((record) => record.value.id),
      ["a", "branch"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("large native output is completely reachable in bounded content pages without flattening", async () => {
  const { root, file } = fixture();
  const text = `START\n${"雪😀\n".repeat(40000)}END`;
  try {
    fs.appendFileSync(
      file,
      entry("large", null, {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call",
        isError: true,
        content: [
          { type: "text", text },
          { type: "image", data: "NOT_TEXT", mimeType: "image/png" },
        ],
      }),
    );
    const journal = new ConversationJournal(file, "child-session");
    const indexedOnOpen = journal.native.indexed;
    assert.equal(indexedOnOpen, false, "opening does not synchronously index a large body");
    assert.equal(
      journal.entries().length,
      0,
      "a partially indexed record is not a published message",
    );
    while (!journal.native.indexed) {
      journal.native.refresh();
    }
    const record = journal.entries()[0];
    const first = await journal.page(record);
    assert.ok(first.pages > 1);
    const parts: string[] = [];
    for (let index = 0; index < first.pages; index++) {
      // oxlint-disable-next-line no-await-in-loop
      const page = await journal.page(record, index);
      assert.equal(page.message.isError, true);
      const content = page.message.content;
      assert.ok(Array.isArray(content));
      const block: unknown = content[0];
      assert.ok(
        typeof block === "object" &&
          block !== null &&
          "text" in block &&
          typeof block.text === "string",
      );
      assert.ok(block.text.length <= 65536);
      assert.equal(block.text.isWellFormed(), true, "content pages do not split a Unicode scalar");
      parts.push(block.text);
      assert.doesNotMatch(JSON.stringify(page), /NOT_TEXT/);
    }
    assert.equal(parts.join(""), text);
    const controller = new AbortController();
    let chunks = 0;
    await assert.rejects(
      journal.native.project(
        record,
        () => true,
        () => {
          chunks++;
          controller.abort();
        },
        controller.signal,
      ),
      { name: "AbortError" },
    );
    assert.ok(chunks > 0, "cancellation occurs after an actual published-body chunk was read");
    assert.equal(
      (await journal.page(record)).message.toolCallId,
      "call",
      "a cancelled body does not poison the next selected read",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hidden thinking does not consume visible message pages", async () => {
  const { root, file } = fixture();
  try {
    fs.appendFileSync(
      file,
      entry("reply", null, {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden".repeat(20000) },
          { type: "text", text: "VISIBLE_REPLY" },
        ],
      }),
    );
    const journal = new ConversationJournal(file, "child-session");
    const record = journal.entries()[0];
    const hidden = await journal.page(record, 0, { hideThinking: true });
    assert.equal(hidden.pages, 1);
    assert.deepEqual(hidden.message.content, [
      { type: "thinking", thinking: "" },
      { type: "text", text: "VISIBLE_REPLY" },
    ]);
    assert.ok(
      (await journal.page(record)).pages > 1,
      "thinking remains reachable when native visibility allows it",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selected conversation refuses foreign and symlink journals and detects replacement before reading a body", async () => {
  const { root, file } = fixture();
  try {
    fs.appendFileSync(file, entry("old", null, { role: "assistant", content: "old child" }));
    assert.throws(() => new ConversationJournal(file, "another-child"), /identity does not match/);
    const journal = new ConversationJournal(file, "child-session");
    const old = journal.entries()[0];
    fs.renameSync(file, file + ".old");
    fs.copyFileSync(file + ".old", file);
    await assert.rejects(journal.page(old), /replaced or truncated/);
    assert.throws(() => journal.native.refresh(), /replaced or truncated/);
    fs.unlinkSync(file);
    fs.symlinkSync(file + ".old", file);
    assert.throws(() => new ConversationJournal(file, "child-session"), /regular file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
