import { HistoryIndexError } from "./types.ts";

import { isRecord } from "../shared/unknown.ts";
export { isRecord as isObject, errorMessage } from "../shared/unknown.ts";
export function object(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}
export function objects(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: readonly unknown[] = value;
  return items.map(object);
}
export function parseObject(text: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new HistoryIndexError("INVALID", "Expected a JSON object.");
  }
  return value;
}
export function errorCode(error: unknown): unknown {
  return object(error).code;
}
export function at(value: unknown, keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    if (Array.isArray(current) && typeof key === "number") {
      const items: readonly unknown[] = current;
      current = items[key];
    } else {
      current = object(current)[String(key)];
    }
  }
  return current;
}
export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
