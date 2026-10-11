import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRecord, isUnknownArray } from "../../src/shared/unknown.ts";

/** Fail closed while retaining false, zero and the empty string as valid values. */
export function assertDefined(
  value: unknown,
): asserts value is object | string | number | boolean | bigint | symbol {
  assert.notEqual(value, undefined, "Expected a defined value");
  assert.notEqual(value, null, "Expected a non-null value");
}

export function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(isRecord(value), "Expected an object");
}

export function assertArray(value: unknown): asserts value is readonly unknown[] {
  assert.ok(isUnknownArray(value), "Expected an array");
}

/** Parsing is not schema validation; callers must narrow their actual payload. */
export function parseJson(input: string): unknown {
  const value: unknown = JSON.parse(input);
  return value;
}

export function readJson(file: string): unknown {
  return parseJson(readFileSync(file, "utf8"));
}

export function record(value: unknown): Record<string, unknown> {
  assertRecord(value);
  return value;
}

export function array(value: unknown): readonly unknown[] {
  assertArray(value);
  return value;
}

export function text(value: unknown): string {
  assert.ok(typeof value === "string", "Expected a string");
  return value;
}

/** For test protocols that specifically require a JSON object, not arbitrary JSON. */
export function json(value: string): Record<string, unknown> {
  return record(parseJson(value));
}

/** Reject a missing/image block instead of silently weakening a text assertion. */
export function textAt(content: unknown, index = 0): string {
  assertArray(content);
  const part = record(content[index]);
  assert.equal(part.type, "text", "Expected a text content block");
  return text(part.text);
}

export function records(value: unknown): readonly Record<string, unknown>[] {
  return array(value).map(record);
}

export function strings(value: unknown): readonly string[] {
  return array(value).map(text);
}

export function numberValue(value: unknown): number {
  assert.ok(typeof value === "number", "Expected a number");
  return value;
}
