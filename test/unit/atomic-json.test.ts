import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { read, runDirectory, write } from "../../src/agent/storage.ts";
import { Type } from "../../src/agent/typebox.ts";
import { observeReads } from "../support/runtime-fs.ts";

it("native agent storage creates private files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-atomic-json-"));
  try {
    const file = path.join(dir, "status.json");
    write(file, { ok: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { ok: true });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("native run paths reject traversal and separators before accessing storage", () => {
  for (const id of [
    "",
    ".",
    "..",
    "../foreign",
    "/tmp/foreign",
    "run/child",
    "run\\child",
    "a".repeat(129),
  ]) {
    assert.throws(() => runDirectory("/owned", id), /Invalid run\/session ID/);
  }
  assert.equal(runDirectory("/owned", "run_12-abc"), path.join("/owned", "run_12-abc"));
});

it("saved owner reads preserve values with snapshot-sized reads and a 64 KiB ceiling", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-owner-read-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "question-owner.json");
  const schema = Type.Object({ sessionId: Type.String() });
  const lengths: number[] = [];
  observeReads(t, ({ length }) => {
    lengths.push(length);
  });
  const owner = '{"sessionId":"owner-🦄"}';
  fs.writeFileSync(file, owner);
  assert.deepEqual(read(file, schema), { sessionId: "owner-🦄" });
  assert.deepEqual(lengths, [Buffer.byteLength(owner)]);
  lengths.length = 0;
  fs.writeFileSync(file, '{"sessionId":"owner"}'.padEnd(70_000));
  assert.deepEqual(read(file, schema), { sessionId: "owner" });
  assert.deepEqual(lengths, [65_536, 4_464]);
});
