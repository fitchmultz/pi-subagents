// Journal and observation assertions shared with the packed-native smoke script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Assert the child journal records its native tool result and completion entry.
 * @param {string} sessionFile
 * @param {string | undefined} terminalEntryId
 * @param {string} completionText
 */
export function assertChildJournal(sessionFile, terminalEntryId, completionText) {
  const childEntries = readFileSync(sessionFile, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) =>
      /** @type {{ id?: string, type?: string, message?: { role?: string, toolName?: string, content?: { text?: string }[] } }} */ (
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- journal line shape, guarded below
        JSON.parse(line)
      ),
    );
  // oxlint-disable typescript/no-unnecessary-condition -- journal fields are optional under tsc
  assert.ok(
    childEntries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message?.toolName === "packed_probe" &&
        entry.message?.content?.some((part) => part.text === "PACKED_TOOL_RESULT") === true,
    ),
    "actual child journal contains its native tool result",
  );
  assert.ok(
    childEntries.some(
      (entry) =>
        entry.id === terminalEntryId &&
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        entry.message?.content?.some((part) => part.text === completionText) === true,
    ),
    "completion references an actually published child assistant entry",
  );
  // oxlint-enable typescript/no-unnecessary-condition
}

/**
 * Assert the recorded observations show the expected broker conversation shape.
 * @param {string} observations
 */
export function assertObservations(observations) {
  /** @type {Record<string, unknown>[]} */
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const observed = readFileSync(observations, "utf8")
    .trimEnd()
    .split("\n")
    // oxlint-disable-next-line typescript/no-unsafe-return
    .map((line) => JSON.parse(line));
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
