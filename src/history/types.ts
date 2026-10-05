export type * from "../shared/types/history.ts";
export type {
  OwnedRun,
  OwnedRunView,
  ForegroundResumeRun,
  ReadonlyForegroundResumeRun,
  ManagementRunState,
} from "../shared/types/owned-runs.ts";

export class HistoryIndexError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HistoryIndexError";
    this.code = code;
  }
}
export interface Request {
  readonly id: number;
  readonly method: string;
  readonly input?: unknown;
}
export type Response =
  | {
      readonly id: number;
      readonly value?: unknown;
      readonly error?: { readonly code: string; readonly message: string };
    }
  | { readonly changed: true };
