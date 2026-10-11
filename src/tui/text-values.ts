import { inspect } from "node:util";

/** Empty recorded strings are not display labels; retain their fallback semantics explicitly. */
export function hasText(value: string): boolean;
export function hasText(value: unknown): value is string;
export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
export function nonemptyText(value: unknown): string | undefined {
  return hasText(value) ? value : undefined;
}
export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return inspect(error, { depth: 2, customInspect: false });
}
