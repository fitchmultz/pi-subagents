import { isRecord, isUnknownArray } from "../../shared/unknown.ts";

export class DynamicFanoutError extends Error {}
const ITEM_REF_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)(?:\.([^{}]+))?\}/g;

export function assertJsonPointer(pointer: string, label: string): void {
  if (pointer === "") {
    return;
  }
  if (!pointer.startsWith("/")) {
    throw new DynamicFanoutError(`${label} must be a JSON Pointer starting with '/'.`);
  }
  for (const segment of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(segment)) {
      throw new DynamicFanoutError(`${label} contains invalid JSON Pointer escape.`);
    }
  }
}

export function resolveJsonPointer(value: unknown, pointer: string, label: string): unknown {
  assertJsonPointer(pointer, label);
  if (pointer === "") {
    return value;
  }
  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (isUnknownArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
        throw new DynamicFanoutError(
          `${label} segment '${segment}' does not address an array index.`,
        );
      }
      const index = Number(segment);
      if (index >= current.length) {
        throw new DynamicFanoutError(`${label} does not exist.`);
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new DynamicFanoutError(`${label} does not exist.`);
    }
    current = current[segment];
  }
  return current;
}

export function scalarToKey(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new DynamicFanoutError(`${label} must resolve to a string, number, or boolean.`);
  }
  const key = String(value);
  if (key.trim().length === 0) {
    throw new DynamicFanoutError(`${label} resolved to an empty key.`);
  }
  // Item identifiers cross process boundaries; reject ASCII C0 controls and DEL.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(key)) {
    throw new DynamicFanoutError(`${label} resolved to an unsafe key.`);
  }
  if (key.length > 200) {
    throw new DynamicFanoutError(`${label} resolved to a key longer than 200 characters.`);
  }
  return key;
}

export function normalizeItemKeyForId(key: string): string {
  const normalized = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized.length > 0 ? normalized : "item";
}

function valueToTemplateText(value: unknown, reference: string): string {
  if (value === undefined) {
    throw new DynamicFanoutError(`Unresolved item reference '${reference}'.`);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

function resolveItemPath(item: unknown, pathText: string | undefined, reference: string): unknown {
  if (pathText === undefined || pathText.length === 0) {
    return item;
  }
  const pointer = `/${pathText
    .split(".")
    .map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;
  return resolveJsonPointer(item, pointer, reference);
}

export function resolveItemTemplate(template: string, itemName: string, item: unknown): string {
  return template.replace(
    ITEM_REF_PATTERN,
    (raw: string, name: string, pathText: string | undefined) => {
      if (name !== itemName) {
        return raw;
      }
      if (pathText !== undefined && (pathText.trim().length === 0 || pathText.includes(".."))) {
        throw new DynamicFanoutError(`Invalid item reference '${raw}'.`);
      }
      return valueToTemplateText(resolveItemPath(item, pathText, raw), raw);
    },
  );
}
