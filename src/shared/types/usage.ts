import type { ObservedUsage } from "./messages.ts";

export interface UsageContribution {
  readonly id: string;
  /** Native tool and summary usage may not carry model attribution. */
  readonly provider?: string;
  readonly model?: string;
  readonly usage: ObservedUsage;
}

export interface Usage {
  readonly contributions?: readonly UsageContribution[];
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly turns: number;
}

/** The billing reducer owns these counters and appends immutable contribution snapshots. */
export interface UsageAccumulator {
  contributions?: UsageContribution[];
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}
