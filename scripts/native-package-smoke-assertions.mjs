// Journal and observation assertions shared with the packed-native smoke script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRecord, isUnknownArray } from "../src/shared/unknown.ts";

function jsonRecords(/** @type {string} */ file) {
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => {
      /** @type {unknown} */ const entry = JSON.parse(line);
      assert.ok(isRecord(entry));
      return entry;
    });
}

function containsText(/** @type {unknown} */ content, /** @type {string} */ text) {
  return isUnknownArray(content) && content.some((part) => isRecord(part) && part.text === text);
}

/**
 * Assert the child journal records its native tool result and completion entry.
 * @param {string} sessionFile
 * @param {string | undefined} terminalEntryId
 * @param {string} completionText
 */
export function assertChildJournal(sessionFile, terminalEntryId, completionText) {
  const childEntries = jsonRecords(sessionFile);
  assert.ok(
    childEntries.some(
      (entry) =>
        entry.type === "message" &&
        isRecord(entry.message) &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "packed_probe" &&
        containsText(entry.message.content, "PACKED_TOOL_RESULT"),
    ),
    "actual child journal contains its native tool result",
  );
  assert.ok(
    childEntries.some(
      (entry) =>
        entry.id === terminalEntryId &&
        entry.type === "message" &&
        isRecord(entry.message) &&
        entry.message.role === "assistant" &&
        containsText(entry.message.content, completionText),
    ),
    "completion references an actually published child assistant entry",
  );
}

/**
 * Assert the recorded observations show the expected broker conversation shape.
 * @param {string} observations
 */
export function assertObservations(observations) {
  const observed = jsonRecords(observations);
  const matches = (/** @type {(item: Record<string, unknown>) => boolean} */ predicate) =>
    observed.filter(predicate).length;
  assert.equal(
    matches((item) => item.child === true && item.modelBound === true),
    1,
  );
  assert.equal(
    matches((item) => item.child === true && item.toolExecuted === true),
    1,
  );
  assert.equal(
    matches((item) => item.child === true && item.consumedResult === true && item.calls === 2),
    1,
  );
  assert.equal(
    matches((item) => item.child !== true && item.consumedResult === true && item.calls === 2),
    1,
  );
  assert.equal(
    matches((item) => item.child !== true && item.consumedCompletion === true && item.calls === 3),
    1,
    "the parent is resumed exactly once by the native completion notification",
  );
  assert.equal(
    observed.some((item) => item.networkAttempt === true),
    false,
  );
}
