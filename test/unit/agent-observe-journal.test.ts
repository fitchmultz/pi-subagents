import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { spy, stub } from "sinon";
import { JournalTail } from "../../src/agent/journal-tail.ts";

const header = `${JSON.stringify({ type: "session", id: "child-session", version: 3 })}\n`;
function entry(message: unknown): string {
  return `${JSON.stringify({ type: "message", id: "entry", message })}\n`;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observe-journal-"));
  const file = path.join(root, "child.jsonl");
  fs.writeFileSync(file, header);
  return { root, file, tail: new JournalTail(file, "child-session") };
}

test("observer reads only LF-published native tool/text activity and renders errors/non-text safely", () => {
  const { root, file, tail } = fixture();
  try {
    fs.appendFileSync(
      file,
      entry({
        role: "assistant",
        content: [
          { type: "text", text: "working 雪😀\u001b]52;c;hostile\u0007" },
          { type: "toolCall", name: "read", arguments: { path: "fact.txt" } },
          { type: "thinking", thinking: "PRIVATE_THINKING" },
        ],
      }),
    );
    const result = entry({
      role: "toolResult",
      toolName: "read",
      isError: true,
      content: [
        { type: "text", text: "actual failure" },
        { type: "image", data: "PRIVATE_IMAGE" },
      ],
    });
    fs.appendFileSync(file, result.slice(0, -1));
    tail.poll();
    assert.deepEqual(tail.lines, [
      "assistant: working 雪😀 ]52;c;hostile ",
      'assistant: tool read {"path":"fact.txt"}',
    ]);
    assert.match(tail.notice, /newline publication/);
    fs.appendFileSync(file, "\n");
    tail.poll();
    assert.deepEqual(tail.lines.slice(-3), [
      "tool error read:",
      "actual failure",
      "[image omitted]",
    ]);
    tail.poll();
    assert.equal(tail.lines.length, 5, "unchanged polling cannot replay entries");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("observer bounds actual filesystem reads, tail memory and oversized/partial entries", () => {
  const { root, file, tail } = fixture();
  const reads = spy(fs, "readSync");
  const lengths = () =>
    reads.getCalls().map((call) => {
      const args: readonly unknown[] = call.args;
      const length = args[3];
      assert.ok(typeof length === "number");
      return length;
    });
  try {
    const fd = fs.openSync(file, "a");
    fs.writeSync(fd, "x".repeat(2 * 1024 * 1024));
    fs.closeSync(fd);
    fs.appendFileSync(
      file,
      "\n" + entry({ role: "assistant", content: [{ type: "text", text: "RECENT_FACT" }] }),
    );
    syncBuiltinESMExports();
    tail.poll();
    assert.deepEqual(tail.lines, [
      "[Earlier native activity omitted; full journal retained.]",
      "assistant: RECENT_FACT",
    ]);
    assert.ok(
      lengths().every((length) => length <= 65536),
      "never read a giant native journal in one tick",
    );
    assert.ok(lengths().reduce((sum, length) => sum + length, 0) <= 69632);
    reads.resetHistory();
    tail.poll();
    assert.ok(
      lengths().reduce((sum, length) => sum + length, 0) <= 4096,
      "idle poll only checks the bounded header",
    );
    fs.appendFileSync(file, "x".repeat(40000));
    tail.poll();
    assert.equal(tail.lines.at(-1), "[Large native entry omitted; read the full journal.]");
    fs.appendFileSync(file, "\nmalformed published JSON\n");
    tail.poll();
    assert.equal(tail.lines.at(-1), "[Malformed published native entry omitted.]");
    for (let i = 0; i < 120; i++) {
      fs.appendFileSync(
        file,
        entry({ role: "assistant", content: [{ type: "text", text: `line-${i}` }] }),
      );
    }
    tail.poll();
    assert.equal(tail.lines.length, 80);
    assert.equal(tail.lines.at(-1), "assistant: line-119");
    assert.ok(tail.lines.every((line) => line.length < 600));
  } finally {
    reads.restore();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("observer preserves prior activity across a skipped large burst and recovers after a transient read error", () => {
  const { root, file, tail } = fixture();
  try {
    tail.poll();
    assert.equal(tail.notice, "Waiting for published native activity.");
    fs.appendFileSync(file, entry({ role: "assistant", content: "BEFORE_BURST" }));
    tail.poll();
    fs.appendFileSync(
      file,
      entry({ role: "toolResult", toolName: "write", content: "x".repeat(100000) }),
    );
    tail.poll();
    assert.equal(tail.lines[0], "assistant: BEFORE_BURST");
    assert.ok(tail.lines.includes("[Earlier native activity omitted; full journal retained.]"));
    fs.appendFileSync(file, entry({ role: "assistant", content: "AFTER_BURST" }));
    tail.poll();
    assert.equal(tail.lines.at(-1), "assistant: AFTER_BURST");
    const open = stub(fs, "openSync").callThrough();
    open.onFirstCall().throws(new Error("TEMPORARY_READ_FAILURE"));
    syncBuiltinESMExports();
    try {
      tail.poll();
      assert.equal(tail.lines.length, 0);
      assert.equal(tail.notice, "TEMPORARY_READ_FAILURE");
    } finally {
      open.restore();
      syncBuiltinESMExports();
    }
    tail.poll();
    assert.equal(
      tail.lines.at(-1),
      "assistant: AFTER_BURST",
      "unchanged file is re-read after recovery",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("observer refuses foreign/symlink journals and resets a replaced or truncated file", () => {
  const { root, file, tail } = fixture();
  try {
    fs.appendFileSync(file, entry({ role: "assistant", content: "OLD_CHILD" }));
    tail.poll();
    fs.writeFileSync(file + ".new", header + entry({ role: "assistant", content: "NEW_CHILD" }));
    fs.renameSync(file + ".new", file);
    tail.poll();
    assert.deepEqual(tail.lines, ["assistant: NEW_CHILD"]);
    fs.writeFileSync(file, header);
    tail.poll();
    assert.deepEqual(tail.lines, []);
    fs.writeFileSync(
      file,
      header.replace("child-session", "foreign-owner") +
        entry({ role: "assistant", content: "FOREIGN" }),
    );
    tail.poll();
    assert.deepEqual(tail.lines, []);
    assert.match(tail.notice, /identity does not match/);
    fs.renameSync(file, file + ".target");
    fs.symlinkSync(file + ".target", file);
    tail.poll();
    assert.deepEqual(tail.lines, []);
    assert.match(tail.notice, /ELOOP/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
