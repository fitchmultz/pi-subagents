import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { it } from "node:test";

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
