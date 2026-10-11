import type { AsyncStatus, ReadonlyInput } from "../../shared/types.ts";

export interface AsyncRunLocation {
  readonly asyncDir: string | null;
  readonly resultPath: string | null;
  readonly resolvedId?: string;
}

/** A discovery pass owns this decoded status and may replace its projection. */
export interface AsyncRunRecord {
  readonly location: AsyncRunLocation;
  status: ReadonlyInput<AsyncStatus> | null;
  readonly durable: boolean;
}
