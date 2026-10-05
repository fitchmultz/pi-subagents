import * as path from "node:path";
import { isRecord } from "./record-value.ts";

const MAX_NESTED_ID_LENGTH = 128;
export const MAX_NESTED_PATH_ENTRIES = 4;

export type NestedPathEntry = {
  readonly runId: string;
  readonly stepIndex?: number;
  readonly agent?: string;
};

export function isSafeNestedPathId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NESTED_ID_LENGTH &&
    !path.isAbsolute(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..")
  );
}

function pathEntry(value: unknown): NestedPathEntry | undefined {
  if (!isRecord(value) || !isSafeNestedPathId(value.runId)) {
    return;
  }
  const stepIndex = value.stepIndex;
  const agent = value.agent;
  return {
    runId: value.runId,
    ...(typeof stepIndex === "number" && Number.isInteger(stepIndex) && stepIndex >= 0
      ? { stepIndex }
      : {}),
    ...(typeof agent === "string" && agent.length > 0 ? { agent: agent.slice(0, 128) } : {}),
  };
}

export function sanitizeNestedPath(value: unknown): NestedPathEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(pathEntry)
    .filter((part): part is NestedPathEntry => part !== undefined)
    .slice(0, MAX_NESTED_PATH_ENTRIES);
}

export function parseNestedPathEnv(value: string | undefined): NestedPathEntry[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return sanitizeNestedPath(parsed);
  } catch {
    return [];
  }
}

export function encodeNestedPathEnv(value: readonly NestedPathEntry[]): string {
  const sanitized = sanitizeNestedPath(value);
  return sanitized.length > 0 ? JSON.stringify(sanitized) : "";
}
