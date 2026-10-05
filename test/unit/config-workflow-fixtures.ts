import { array, record } from "../support/assertions.ts";

/** Observe serialized config fields without asserting a schema the parser has not validated. */
export function objectAt(
  value: unknown,
  ...keys: readonly (string | number)[]
): Readonly<Record<string, unknown>> {
  let current = value;
  for (const key of keys) {
    current = typeof key === "number" ? array(current)[key] : record(current)[key];
  }
  return record(current);
}
