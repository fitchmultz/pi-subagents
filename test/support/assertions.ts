import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Fail closed while retaining false, zero and the empty string as valid values. */
export function assertDefined(value: unknown): asserts value is NonNullable<unknown> {
  assert.notEqual(value, undefined, "Expected a defined value");
  assert.notEqual(value, null, "Expected a non-null value");
}

export function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "Expected an object",
  );
}

export function assertArray(value: unknown): asserts value is unknown[] {
  assert.ok(Array.isArray(value), "Expected an array");
}

/** Parsing is not schema validation; callers must narrow their actual payload. */
export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

export function readJson(file: string): unknown {
  return parseJson(readFileSync(file, "utf8"));
}
