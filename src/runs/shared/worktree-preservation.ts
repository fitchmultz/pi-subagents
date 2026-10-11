import type { WorktreeSetup } from "./worktree-contract.ts";

/** Resource owner mutation: failed patch capture must prohibit destructive cleanup. */
export function markWorktreesForPreservation(setup: WorktreeSetup, reason: string): void {
  setup.preserveOnCleanup = true;
  setup.preservationReason =
    (setup.preservationReason ?? "").length > 0
      ? `${setup.preservationReason ?? ""}; ${reason}`
      : reason;
}
