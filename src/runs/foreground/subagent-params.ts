import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDiscoveryOptions } from "../../agents/agents.ts";
import type { AgentConfig, AgentScope } from "../../shared/types/config.ts";
import {
  materializeAgentDefaultOutputPath,
  normalizeSingleOutputOverride,
} from "../shared/single-output.ts";
import type { IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import type {
  ChainStep,
  DynamicParallelStep,
  ParallelStep,
  SequentialStep,
} from "../../shared/types/workflow.ts";
import type {
  AcceptanceInput,
  ControlConfig,
  ExtensionConfig,
  JsonSchemaObject,
  MaxOutputConfig,
  ManagementRunState,
  NestedRouteInfo,
  ResolvedControlConfig,
  ReadonlySingleResult,
  Details,
  SubagentRunMode,
  SubagentState,
  ReadonlyInput,
  ReadonlySubagentState,
} from "../../shared/types.ts";

export function maxParallelTasksMessage(maxParallelTasks: number): string {
  return `Max ${maxParallelTasks} tasks. Split the batch into smaller parallel calls or raise parallel.maxTasks in ~/.pi/agent/extensions/subagent/config.json.`;
}

export type TaskParam = ReadonlyInput<TaskParamData>;
interface TaskParamData {
  agent: string;
  task: string;
  label?: string;
  cwd?: string;
  count?: number;
  outputSchema?: JsonSchemaObject;
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
  reads?: string[] | boolean;
  progress?: boolean;
  model?: string;
  skill?: string | string[] | boolean;
  acceptance?: AcceptanceInput;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskParamLike(value: unknown): value is TaskParam {
  return isRecord(value) && typeof value.agent === "string";
}

function isDynamicParallelStepLike(value: unknown): value is DynamicParallelStep {
  return (
    isRecord(value) &&
    isRecord(value.expand) &&
    isRecord(value.parallel) &&
    typeof value.parallel.agent === "string" &&
    isRecord(value.collect) &&
    typeof value.collect.as === "string"
  );
}

function isParallelStepLike(value: unknown): value is ParallelStep {
  return isRecord(value) && Array.isArray(value.parallel) && value.parallel.every(isTaskParamLike);
}

function isSequentialStepLike(value: unknown): value is SequentialStep {
  return isRecord(value) && typeof value.agent === "string";
}

function isChainStepLike(value: unknown): value is ChainStep {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isDynamicParallelStepLike(value) || isParallelStepLike(value) || isSequentialStepLike(value)
  );
}

export type SubagentParamsLike = ReadonlyInput<SubagentParamsData>;
interface SubagentParamsData {
  action?: string;
  id?: string;
  runId?: string;
  questionId?: string;
  decision?: "accepted" | "needs_changes";
  offset?: number;
  limit?: number;
  cursor?: string;
  sort?: "attention" | "newest" | "oldest" | "relevance";
  state?: ManagementRunState;
  text?: string;
  query?: string;
  before?: number;
  full?: boolean;
  dir?: string;
  index?: number;
  agent?: string;
  task?: string;
  label?: string;
  message?: string;
  /** Internal human-view provenance; not accepted by the model tool schema. */
  messageOrigin?: "human";
  chain?: ChainStep[];
  tasks?: TaskParam[];
  concurrency?: number;
  timeoutMs?: number;
  maxRuntimeMs?: number;
  extendMs?: number;
  worktree?: boolean;
  context?: "fresh" | "fork";
  async?: boolean;
  clarify?: boolean;
  share?: boolean;
  control?: ControlConfig;
  sessionDir?: string;
  cwd?: string;
  maxOutput?: MaxOutputConfig;
  artifacts?: boolean;
  includeProgress?: boolean;
  progress?: boolean;
  model?: string;
  skill?: string | string[] | boolean;
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
  outputSchema?: JsonSchemaObject;
  agentScope?: string;
  chainName?: string;
  config?: unknown;
  chainDir?: string;
  acceptance?: AcceptanceInput;
}

export function resolveAsyncExecutionMode(
  params: Pick<SubagentParamsLike, "async" | "clarify" | "timeoutMs" | "maxRuntimeMs">,
  asyncByDefault: boolean,
): { effectiveAsync: boolean; backgroundRequestedWhileClarifying: boolean } {
  const hasForegroundTimeout = params.timeoutMs !== undefined || params.maxRuntimeMs !== undefined;
  const requestedAsync = params.async ?? (hasForegroundTimeout ? false : asyncByDefault);
  return {
    effectiveAsync: requestedAsync && params.clarify !== true,
    backgroundRequestedWhileClarifying: params.async === true && params.clarify === true,
  };
}

interface RawSubagentParamsLike {
  readonly [key: string]: unknown;
}

function stringValue(params: RawSubagentParamsLike, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function booleanValue(params: RawSubagentParamsLike, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(params: RawSubagentParamsLike, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}

function contextValue(params: RawSubagentParamsLike): SubagentParamsLike["context"] {
  const value = params.context;
  return value === "fresh" || value === "fork" ? value : undefined;
}

function outputModeValue(params: RawSubagentParamsLike): SubagentParamsLike["outputMode"] {
  const value = params.outputMode;
  return value === "inline" || value === "file-only" ? value : undefined;
}

function outputValue(params: RawSubagentParamsLike): SubagentParamsLike["output"] {
  const value = params.output;
  return typeof value === "string" || typeof value === "boolean" ? value : undefined;
}

export function usesAgentDefaultOutput(output: string | boolean | undefined): boolean {
  return output === undefined || output === true || output === "true";
}

export function resolveTopLevelOutputOverride(params: {
  readonly requestedOutput: string | boolean | undefined;
  readonly agentDefaultOutput: string | false | undefined;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly agent: string;
  readonly index?: number;
}): string | false | undefined {
  const effectiveOutput = usesAgentDefaultOutput(params.requestedOutput)
    ? normalizeSingleOutputOverride(true, params.agentDefaultOutput)
    : normalizeSingleOutputOverride(params.requestedOutput, params.agentDefaultOutput);
  if (!usesAgentDefaultOutput(params.requestedOutput)) {
    return effectiveOutput;
  }
  return materializeAgentDefaultOutputPath({
    output: effectiveOutput,
    artifactsDir: params.artifactsDir,
    runId: params.runId,
    agent: params.agent,
    index: params.index,
  });
}

function skillValue(params: RawSubagentParamsLike): SubagentParamsLike["skill"] {
  const value = params.skill;
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (!Array.isArray(value)) {
    return;
  }
  const items: unknown[] = value;
  return items.every((item): item is string => typeof item === "string") ? items : undefined;
}
function maxOutputValue(params: RawSubagentParamsLike): MaxOutputConfig | undefined {
  const value = params.maxOutput;
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    ...(typeof value.lines === "number" ? { lines: value.lines } : {}),
  };
}

function isControlConfig(value: unknown): value is ControlConfig {
  return isRecord(value);
}

function isAcceptanceInput(value: unknown): value is AcceptanceInput {
  return isRecord(value);
}

function sortValue(value: unknown): SubagentParamsLike["sort"] {
  switch (value) {
    case "attention":
    case "newest":
    case "oldest":
    case "relevance":
      return value;
    default:
      return;
  }
}
function stateValue(value: unknown): ManagementRunState | undefined {
  switch (value) {
    case "live":
    case "completed":
    case "failed":
    case "blocked":
    case "paused":
    case "unknown":
      return value;
    default:
      return;
  }
}
export function normalizeSubagentParamsLike(params: RawSubagentParamsLike): SubagentParamsLike {
  const normalized: SubagentParamsLike = {
    action: stringValue(params, "action"),
    id: stringValue(params, "id"),
    runId: stringValue(params, "runId"),
    questionId: stringValue(params, "questionId"),
    decision:
      params.decision === "accepted" || params.decision === "needs_changes"
        ? params.decision
        : undefined,
    offset: numberValue(params, "offset"),
    limit: numberValue(params, "limit"),
    cursor: stringValue(params, "cursor"),
    sort: sortValue(params.sort),
    state: stateValue(params.state),
    text: stringValue(params, "text"),
    query: stringValue(params, "query"),
    before: numberValue(params, "before"),
    full: booleanValue(params, "full"),
    dir: stringValue(params, "dir"),
    index: numberValue(params, "index"),
    agent: stringValue(params, "agent"),
    task: stringValue(params, "task"),
    label: stringValue(params, "label"),
    message: stringValue(params, "message"),
    concurrency: numberValue(params, "concurrency"),
    timeoutMs: numberValue(params, "timeoutMs"),
    maxRuntimeMs: numberValue(params, "maxRuntimeMs"),
    extendMs: numberValue(params, "extendMs"),
    worktree: booleanValue(params, "worktree"),
    context: contextValue(params),
    async: booleanValue(params, "async"),
    clarify: booleanValue(params, "clarify"),
    share: booleanValue(params, "share"),
    control: isControlConfig(params.control) ? params.control : undefined,
    sessionDir: stringValue(params, "sessionDir"),
    cwd: stringValue(params, "cwd"),
    maxOutput: maxOutputValue(params),
    artifacts: booleanValue(params, "artifacts"),
    includeProgress: booleanValue(params, "includeProgress"),
    progress: booleanValue(params, "progress"),
    model: stringValue(params, "model"),
    skill: skillValue(params),
    output: outputValue(params),
    outputMode: outputModeValue(params),
    outputSchema: isRecord(params.outputSchema) ? params.outputSchema : undefined,
    agentScope: stringValue(params, "agentScope"),
    chainName: stringValue(params, "chainName"),
    config: params.config,
    chainDir: stringValue(params, "chainDir"),
    acceptance: isAcceptanceInput(params.acceptance) ? params.acceptance : undefined,
  };
  return { ...normalized, tasks: taskArray(params.tasks), chain: chainArray(params.chain) };
}
function taskArray(value: unknown): TaskParam[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || !value.every(isTaskParamLike)) {
    throw new Error("tasks must be an array of task objects with an agent.");
  }
  return value;
}
function chainArray(value: unknown): ChainStep[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || !value.every(isChainStepLike)) {
    throw new Error("chain must contain valid sequential, parallel, or dynamic fanout steps.");
  }
  return value;
}

export type ExecutorReadDeps = Readonly<Omit<ExecutorDeps, "state">> & {
  readonly state: ReadonlySubagentState;
};
export interface ExecutorDeps {
  readonly pi: ExtensionAPI;
  readonly state: SubagentState;
  readonly config: ExtensionConfig;
  readonly asyncByDefault: boolean;
  readonly tempArtifactsDir: string;
  readonly getSubagentSessionRoot: (parentSessionFile: string | null) => string;
  readonly expandTilde: (p: string) => string;
  readonly discoverAgents: (
    cwd: string,
    scope: AgentScope,
    options?: ReadonlyInput<AgentDiscoveryOptions>,
  ) => { readonly agents: readonly AgentConfig[] };
  readonly allowMutatingManagementActions?: boolean;
  readonly ensureSessionState?: (ctx: ExtensionContext) => void | Promise<void>;
}

export interface ExecutionContextData {
  readonly params: SubagentParamsLike;
  readonly effectiveCwd: string;
  readonly ctx: ExtensionContext;
  readonly signal: AbortSignal | undefined;
  readonly onUpdate?: AgentToolUpdateCallback<Details>;
  readonly agents: readonly AgentConfig[];
  readonly runId: string;
  readonly shareEnabled: boolean;
  readonly sessionRoot: string;
  readonly sessionDirForIndex: (idx?: number) => string;
  readonly sessionFileForIndex: (idx?: number) => string | undefined;
  readonly sessionFileForAgentIndex: (
    agentName: string | undefined,
    idx?: number,
  ) => string | undefined;
  readonly artifactsEnabled: boolean;
  readonly artifactsDir: string;
  readonly backgroundRequestedWhileClarifying: boolean;
  readonly effectiveAsync: boolean;
  readonly foregroundTimeoutMs?: number;
  readonly controlConfig: ResolvedControlConfig;
  readonly intercomBridge: Readonly<IntercomBridgeState>;
  readonly nestedRoute?: NestedRouteInfo;
  readonly onDetachedResultsSettled?: (
    mode: SubagentRunMode,
    results: readonly ReadonlySingleResult[],
    totalSteps?: number,
  ) => void;
}
