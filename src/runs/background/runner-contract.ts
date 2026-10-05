import type { ReadonlyDeep } from "type-fest";
import type {
  ArtifactPaths,
  AsyncResultChild,
  ChildProjectTrustPolicy,
  NestedRouteInfo,
} from "../../shared/types.ts";
import type { ChildEvent } from "../shared/child-attempt.ts";
import type { MutationToolResult } from "../shared/mutating-tool-guard.ts";
export type { SubagentRunConfig } from "./runner-config.ts";

export interface RunSingleStepResult extends AsyncResultChild {
  agent: string;
  output: string;
  exitCode: number;
  artifactPaths?: ArtifactPaths;
  completionGuardTriggered?: boolean;
}

export interface SingleStepContext {
  readonly nativeFinalization?: boolean;
  readonly worktreePath?: string;
  readonly rootSessionId?: string;
  readonly cwd: string;
  readonly sessionEnabled: boolean;
  readonly sessionDir?: string;
  readonly artifactsDir?: string;
  readonly id: string;
  readonly flatIndex: number;
  readonly flatStepCount: number;
  readonly outputFile: string;
  readonly registerInterrupt?: (interrupt: (() => void) | undefined) => void;
  readonly signal?: AbortSignal;
  readonly interruptSignal?: AbortSignal;
  readonly childIntercomTarget?: string;
  readonly orchestratorIntercomTarget?: string;
  readonly nestedRoute?: NestedRouteInfo;
  readonly projectTrust?: ChildProjectTrustPolicy;
  readonly onAttemptStart?: (attempt: Readonly<{ model?: string; thinking?: string }>) => void;
  readonly onChildEvent?: (
    event: ReadonlyDeep<ChildEvent>,
    mutation?: ReadonlyDeep<MutationToolResult>,
  ) => void;
}

export interface StepResult extends AsyncResultChild {
  agent: string;
  output: string;
  success: boolean;
  artifactPaths?: ArtifactPaths;
}
