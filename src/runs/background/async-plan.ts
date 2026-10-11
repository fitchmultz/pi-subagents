/**
 * Async execution logic for subagent tool
 */

import type { ReadonlyDeep } from "type-fest";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { applyThinkingSuffix } from "../shared/pi-args.ts";
import {
  materializeAgentDefaultOutputPath,
  normalizeSingleOutputOverride,
} from "../shared/single-output.ts";
import {
  buildModelCandidates,
  resolveModelCandidate,
  type AvailableModelInfo,
} from "../shared/model-fallback.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import {
  type AcceptanceInput,
  type ChainStep,
  type ChildProjectTrustPolicy,
  type Details,
  type JsonSchemaObject,
  type MaxOutputConfig,
  type NestedRouteInfo,
  type ResolvedControlConfig,
  type SavedLaunchConfig,
  type SubagentRunMode,
  type RunnerSubagentStep,
  DEFAULT_MAX_OUTPUT,
} from "../../shared/types.ts";

export function usesAgentDefaultOutput(output: string | boolean | undefined): boolean {
  return output === undefined || output === true || output === "true";
}

export function materializeAsyncDefaultOutput(
  params: Readonly<{
    output: string | false | undefined;
    artifactsDir: string | undefined;
    asyncDir: string;
    runId: string;
    agent: string;
    index?: number | string;
  }>,
): string | false | undefined {
  return materializeAgentDefaultOutputPath({
    output: params.output,
    artifactsDir: params.artifactsDir ?? params.asyncDir,
    runId: params.runId,
    agent: params.agent,
    index: params.index,
  });
}

export function resolveAsyncOutput(
  params: Readonly<{
    requestedOutput: string | boolean | undefined;
    agentDefaultOutput: string | false | undefined;
    artifactsDir: string | undefined;
    asyncDir: string;
    runId: string;
    agent: string;
    index?: number | string;
  }>,
): string | false | undefined {
  const effectiveOutput = usesAgentDefaultOutput(params.requestedOutput)
    ? normalizeSingleOutputOverride(true, params.agentDefaultOutput)
    : normalizeSingleOutputOverride(params.requestedOutput, params.agentDefaultOutput);
  return usesAgentDefaultOutput(params.requestedOutput)
    ? materializeAsyncDefaultOutput({
        output: effectiveOutput,
        artifactsDir: params.artifactsDir,
        asyncDir: params.asyncDir,
        runId: params.runId,
        agent: params.agent,
        index: params.index,
      })
    : effectiveOutput;
}

export interface AsyncExecutionContext {
  rootSessionId?: string;
  pi: Readonly<{ events: Readonly<Pick<ExtensionAPI["events"], "emit">> }>;
  cwd: string;
  currentSessionId: string;
  currentModelProvider?: string;
  projectTrusted?: boolean;
}

interface AsyncChainOptions {
  timeoutMs?: number;
  chain: ChainStep[];
  task?: string;
  resultMode?: Exclude<SubagentRunMode, "single">;
  agents: AgentConfig[];
  ctx: AsyncExecutionContext;
  availableModels?: AvailableModelInfo[];
  cwd?: string;
  chainDir?: string;
  maxOutput?: MaxOutputConfig;
  artifactsDir?: string;
  shareEnabled: boolean;
  sessionRoot?: string;
  chainSkills?: string[] | false;
  sessionFilesByFlatIndex?: (string | undefined)[];
  dynamicFanoutMaxItems?: number;
  maxSubagentDepth: number;
  worktreeSetupHook?: string;
  worktreeSetupHookTimeoutMs?: number;
  controlConfig?: ResolvedControlConfig;
  controlIntercomTarget?: string;
  childIntercomTarget?: (agent: string, index: number) => string | undefined;
  nestedRoute?: NestedRouteInfo;
  projectTrust?: ChildProjectTrustPolicy;
}

interface AsyncSingleOptions {
  timeoutMs?: number;
  agent: string;
  task?: string;
  agentConfig: AgentConfig;
  ctx: AsyncExecutionContext;
  cwd?: string;
  maxOutput?: MaxOutputConfig;
  artifactsDir?: string;
  shareEnabled: boolean;
  sessionRoot?: string;
  sessionFile?: string;
  skills?: string[] | false;
  output?: string | boolean;
  outputFromAgentDefault?: boolean;
  generatedOutputFilename?: string;
  outputMode?: "inline" | "file-only";
  outputSchema?: JsonSchemaObject;
  modelOverride?: string;
  savedLaunch?: SavedLaunchConfig;
  availableModels?: AvailableModelInfo[];
  maxSubagentDepth: number;
  worktreeSetupHook?: string;
  worktreeSetupHookTimeoutMs?: number;
  controlConfig?: ResolvedControlConfig;
  controlIntercomTarget?: string;
  childIntercomTarget?: (agent: string, index: number) => string | undefined;
  nestedRoute?: NestedRouteInfo;
  acceptance?: AcceptanceInput;
  progress?: boolean;
  projectTrust?: ChildProjectTrustPolicy;
}

export type AsyncChainParams = ReadonlyDeep<Omit<AsyncChainOptions, "ctx">> & {
  readonly ctx: Readonly<AsyncExecutionContext>;
};
export type AsyncSingleParams = ReadonlyDeep<Omit<AsyncSingleOptions, "ctx">> & {
  readonly ctx: Readonly<AsyncExecutionContext>;
};

function outputFilename(
  step: ReadonlyDeep<RunnerSubagentStep>,
  agent: ReadonlyDeep<AgentConfig>,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  if (
    step.outputPathFromAgentDefault !== true ||
    step.outputPath === undefined ||
    step.outputPath.length === 0
  ) {
    return;
  }
  if (typeof agent.output !== "string" || path.isAbsolute(agent.output)) {
    return;
  }
  return path.basename(agent.output);
}

export function withSavedLaunch(
  step: RunnerSubagentStep,
  agent: ReadonlyDeep<AgentConfig>,
  params: AsyncChainParams | AsyncSingleParams,
  generatedOutputFilename?: string,
): RunnerSubagentStep {
  return {
    ...step,
    launch: {
      agent,
      model: step.model,
      thinking: step.thinking,
      modelCandidates: step.modelCandidates ?? [],
      artifacts: params.artifactsDir !== undefined,
      artifactsDir: params.artifactsDir,
      share: params.shareEnabled,
      systemPrompt: step.systemPrompt ?? "",
      skills: step.skills ?? [],
      cwd: step.cwd ?? params.ctx.cwd,
      context: agent.defaultContext ?? "fresh",
      output: step.outputPath ?? false,
      outputMode: step.outputMode ?? "inline",
      generatedOutputFilename: outputFilename(step, agent, generatedOutputFilename),
      outputSchema: step.structuredOutputSchema,
      effectiveAcceptance: step.effectiveAcceptance,
      maxOutput: { ...DEFAULT_MAX_OUTPUT, ...params.maxOutput },
      maxSubagentDepth: step.maxSubagentDepth,
      maxExecutionTimeMs: step.maxExecutionTimeMs,
      maxTokens: step.maxTokens,
      controlConfig: params.controlConfig,
      projectTrust: params.projectTrust,
      projectTrusted: params.ctx.projectTrusted,
    },
  };
}

export function resolveLaunchModel(
  agent: ReadonlyDeep<AgentConfig>,
  modelOverride: string | undefined,
  options: ReadonlyDeep<{
    availableModels?: readonly AvailableModelInfo[];
    preferredProvider?: string;
    savedLaunch?: SavedLaunchConfig;
  }>,
): Pick<RunnerSubagentStep, "model" | "thinking" | "modelCandidates"> {
  const { availableModels, preferredProvider, savedLaunch } = options;
  const primary = modelOverride ?? savedLaunch?.model ?? agent.model;
  const thinking = savedLaunch?.thinking ?? agent.thinking;
  const model = applyThinkingSuffix(
    resolveModelCandidate(primary, availableModels, preferredProvider),
    thinking,
  );
  // Only caller selections pin the route; persisted candidates already encode the saved policy.
  const fallbacks =
    modelOverride !== undefined && modelOverride.length > 0
      ? []
      : (savedLaunch?.modelCandidates ?? agent.fallbackModels);
  return {
    model,
    thinking: resolveEffectiveThinking(model, thinking),
    modelCandidates: buildModelCandidates(primary, fallbacks, availableModels, preferredProvider)
      .map((candidate) => applyThinkingSuffix(candidate, thinking))
      .filter((candidate): candidate is string => typeof candidate === "string"),
  };
}

export interface AsyncExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: Details;
  isError?: boolean;
}

export const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

export function agentRuntimeFields(
  agent: ReadonlyDeep<AgentConfig>,
): Pick<
  RunnerSubagentStep,
  | "tools"
  | "allowSubagents"
  | "extensions"
  | "mcpDirectTools"
  | "completionGuard"
  | "systemPromptMode"
  | "inheritProjectContext"
  | "inheritSkills"
  | "maxExecutionTimeMs"
  | "maxTokens"
> {
  return {
    tools: agent.tools,
    allowSubagents: agent.allowSubagents,
    extensions: agent.extensions,
    mcpDirectTools: agent.mcpDirectTools,
    completionGuard: agent.completionGuard,
    systemPromptMode: agent.systemPromptMode,
    inheritProjectContext: agent.inheritProjectContext,
    inheritSkills: agent.inheritSkills,
    maxExecutionTimeMs: agent.maxExecutionTimeMs,
    maxTokens: agent.maxTokens,
  };
}

export class UnavailableSubagentSkillError extends Error {}
export class AsyncStartValidationError extends Error {}
