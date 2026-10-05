import { inspect } from "node:util";

/** Narrow data from CLI stdout, capture files and native journal projections. */
export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorCode(error: unknown): unknown {
  return isObject(error) ? error.code : undefined;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "symbol"
  ) {
    return String(error);
  }
  return inspect(error);
}

export function nonempty(value: string): boolean;
export function nonempty(value: string | null | undefined): value is string;
export function nonempty(value: string | null | undefined): boolean {
  return value !== undefined && value !== null && value.length > 0;
}
