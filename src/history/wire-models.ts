import { Type, Check } from "../shared/native-typebox.ts";
import {
  HistoryIndexError,
  type HistoryEntry,
  type HistoryResult,
  type Response,
} from "./types.ts";
import { parseHistoryEntry, parseHistoryResult } from "../runs/background/run-schemas.ts";
export {
  parseOwnedRun,
  parseHistoryRunRow as parseRunRow,
  parseHistoryRunPage as parseRunPage,
  parseHistoryPage as parsePage,
  parseHistorySearchPage as parseSearchPage,
  parseHistoryIndexStatus as parseStatus,
} from "../runs/background/run-schemas.ts";

const response = Type.Union([
  Type.Object({ changed: Type.Literal(true) }),
  Type.Object({
    id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    value: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
  }),
]);
function invalid(): never {
  throw new HistoryIndexError("INVALID", "Invalid history data at process/index boundary.");
}
export function parseResponse(value: unknown): Response {
  if (!Check(response, value)) {
    invalid();
  }
  return value;
}
export function parseEntry(value: unknown): HistoryEntry | null {
  return value === null ? null : parseHistoryEntry(value);
}
export function parseResult(value: unknown): HistoryResult | null {
  return value === null ? null : parseHistoryResult(value);
}
export function parseNothing(value: unknown): void {
  if (value !== undefined) {
    invalid();
  }
}
export function parseBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    invalid();
  }
  return value;
}
