/** Stable native-JSON identity for cache hashes and repeated tool-call detection. */
export function stableStringify(value: unknown): string {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries: Array<[string, unknown]> = Object.entries(value);
  entries.sort(([left], [right]) => (left > right ? 1 : -1));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}
