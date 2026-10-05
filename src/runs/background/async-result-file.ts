import type {
  AsyncResultChild,
  AsyncResultFile,
  AsyncResultTerminalState,
} from "../../shared/types.ts";
import { ownerProjection, readJsonProjection } from "../../shared/journal-reader.ts";
import { errorCode, errorMessage } from "./async-value.ts";
import { parseAsyncResult } from "./run-schemas.ts";

export function isDurableRun(value: unknown): boolean {
  return isRecord(value) && value.runtimeVersion === 2;
}

export type ParsedAsyncResultFile = Omit<AsyncResultFile, "results"> & {
  results?: AsyncResultChild[];
  terminalState: AsyncResultTerminalState;
};

function getErrorMessage(error: unknown): string {
  return errorMessage(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export function deriveAsyncResultTerminalState(
  input: Readonly<Pick<AsyncResultFile, "success" | "state" | "exitCode">>,
): AsyncResultTerminalState {
  if (input.success === true) {
    return "complete";
  }
  if (input.success === false) {
    if (input.state === "blocked" || input.state === "paused") {
      return input.state;
    }
    return "failed";
  }
  if (
    input.state === "complete" ||
    input.state === "failed" ||
    input.state === "blocked" ||
    input.state === "paused"
  ) {
    return input.state;
  }
  if (input.exitCode === 0) {
    return "paused";
  }
  return "failed";
}

function normalizeResultChild(value: unknown, index: number, resultPath: string): AsyncResultChild {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid async result file '${resultPath}': results[${index}] must be an object.`,
    );
  }
  return value;
}

export function readAsyncResultFile(resultPath: string): ParsedAsyncResultFile {
  let value: unknown;
  try {
    value = readJsonProjection(resultPath, ownerProjection);
  } catch (error) {
    throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new Error(`Failed to parse async result file '${resultPath}': expected a JSON object.`);
  }
  const data = parseAsyncResult(value);
  if (value.results !== undefined && !Array.isArray(value.results)) {
    throw new Error(`Invalid async result file '${resultPath}': results must be an array.`);
  }
  return {
    ...data,
    results: data.results?.map((child, index) => normalizeResultChild(child, index, resultPath)),
    terminalState: deriveAsyncResultTerminalState(data),
  };
}

export function readAsyncResultFileIfExists(resultPath: string): ParsedAsyncResultFile | undefined {
  try {
    return readAsyncResultFile(resultPath);
  } catch (error) {
    if (isNotFoundError(error instanceof Error ? error.cause : undefined)) {
      return undefined;
    }
    throw error;
  }
}
