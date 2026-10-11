export interface WorktreeInfo {
  readonly path: string;
  readonly agentCwd: string;
  readonly branch: string;
  readonly index: number;
  readonly syntheticPaths: readonly string[];
}

/** The run owns these resources; capture failure can forbid their cleanup. */
export interface WorktreeSetup {
  readonly cwd: string;
  readonly worktrees: readonly WorktreeInfo[];
  readonly baseCommit: string;
  preserveOnCleanup?: boolean;
  preservationReason?: string;
}

export interface WorktreeDiff {
  readonly index: number;
  readonly agent: string;
  readonly branch: string;
  readonly diffStat: string;
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly patchPath: string;
  readonly worktreePath?: string;
  readonly captureError?: string;
}
