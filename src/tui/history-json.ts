import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { isRecord } from "./history-text.ts";
export function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((part: unknown) => isJson(part));
  }
  return isJsonObject(value);
}
export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJson);
}
