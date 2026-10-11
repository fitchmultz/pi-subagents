import type { OwnedRun, ReadonlyForegroundResumeRun } from "../../shared/types.ts";

/** Projection consumers cannot replace owner maps or mutate their record snapshots. */
export interface OwnedRunReadState {
  readonly ownedRuns?: Readonly<ReadonlyMap<string, OwnedRun>>;
  readonly foregroundRuns?: Readonly<ReadonlyMap<string, ReadonlyForegroundResumeRun>>;
}
