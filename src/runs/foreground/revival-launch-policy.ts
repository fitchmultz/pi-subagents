import type { executeAsyncSingle } from "../background/async-execution.ts";
import type { SupervisorRunContract } from "../shared/supervisor-questions.ts";
import { acceptanceInputFromResolved } from "../shared/acceptance.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { resolveConfiguredChildProjectTrustPolicy } from "../shared/pi-args.ts";
import {
  resolveCurrentMaxSubagentDepth,
  type ExtensionConfig,
  type ReadonlyInput,
  type SavedLaunchConfig,
} from "../../shared/types.ts";
import type { SubagentParamsLike } from "./subagent-params.ts";
interface PolicyInput {
  readonly params: SubagentParamsLike;
  readonly contract: ReadonlyInput<SupervisorRunContract>;
  readonly saved?: SavedLaunchConfig;
  readonly generatedOutputFilename?: string;
  readonly config: ExtensionConfig;
  readonly tempArtifactsDir: string;
}
type Launch = Parameters<typeof executeAsyncSingle>[1];
function resources(input: PolicyInput): Pick<Launch, "maxOutput" | "shareEnabled"> {
  return {
    maxOutput: input.params.maxOutput ?? input.saved?.maxOutput,
    shareEnabled: input.params.share ?? input.saved?.share ?? false,
  };
}
function artifacts(input: PolicyInput): Pick<Launch, "artifactsDir"> {
  const disabled =
    input.params.artifacts === false ||
    (input.params.artifacts === undefined && input.saved?.artifacts === false);
  return {
    artifactsDir: disabled ? undefined : (input.saved?.artifactsDir ?? input.tempArtifactsDir),
  };
}
function outputTarget(input: PolicyInput): Pick<Launch, "output" | "generatedOutputFilename"> {
  const filename = input.generatedOutputFilename;
  const output =
    filename !== undefined && filename.length > 0
      ? true
      : (input.saved?.output ?? input.contract.output);
  return { output: input.params.output ?? output, generatedOutputFilename: filename };
}
function outputFormat(input: PolicyInput): Pick<Launch, "outputMode" | "outputSchema"> {
  return {
    outputMode: input.params.outputMode ?? input.saved?.outputMode ?? input.contract.outputMode,
    outputSchema:
      input.params.outputSchema ?? input.saved?.outputSchema ?? input.contract.outputSchema,
  };
}
function acceptance(input: PolicyInput): Pick<Launch, "acceptance"> {
  return {
    acceptance:
      input.params.acceptance ??
      acceptanceInputFromResolved(
        input.contract.effectiveAcceptance ?? input.saved?.effectiveAcceptance,
      ),
  };
}
function control(
  input: PolicyInput,
): Pick<
  Launch,
  | "controlConfig"
  | "projectTrust"
  | "maxSubagentDepth"
  | "worktreeSetupHook"
  | "worktreeSetupHookTimeoutMs"
> {
  return {
    controlConfig: resolveControlConfig(
      input.saved?.controlConfig ?? input.config.control,
      input.params.control,
    ),
    projectTrust:
      input.saved?.projectTrust ??
      resolveConfiguredChildProjectTrustPolicy(input.config.projectTrust),
    maxSubagentDepth:
      input.saved?.maxSubagentDepth ??
      resolveCurrentMaxSubagentDepth(input.config.maxSubagentDepth),
    worktreeSetupHook: input.config.worktreeSetupHook,
    worktreeSetupHookTimeoutMs: input.config.worktreeSetupHookTimeoutMs,
  };
}
/** Explicit overrides win over the frozen launch; legacy contract output/acceptance remain recoverable. */
export function resolveRevivalLaunchPolicy(
  input: PolicyInput,
): Pick<
  Launch,
  | "artifactsDir"
  | "maxOutput"
  | "shareEnabled"
  | "output"
  | "generatedOutputFilename"
  | "outputMode"
  | "outputSchema"
  | "acceptance"
  | "controlConfig"
  | "projectTrust"
  | "maxSubagentDepth"
  | "worktreeSetupHook"
  | "worktreeSetupHookTimeoutMs"
> {
  return {
    ...artifacts(input),
    ...resources(input),
    ...outputTarget(input),
    ...outputFormat(input),
    ...acceptance(input),
    ...control(input),
  };
}
