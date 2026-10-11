import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { providerQualifiedModelId, toModelInfo } from "../../shared/model-info.ts";
import { resolveCurrentSessionId, resolveRootSessionId } from "../../shared/session-identity.ts";
import {
  resolveIntercomBridge,
  resolveIntercomSessionTarget,
  resolveOrchestratorIntercomTarget,
  resolveSubagentIntercomTarget,
} from "../../intercom/intercom-bridge.ts";
import { executeAsyncSingle, formatAsyncStartedMessage } from "../background/async-execution.ts";
import { buildRevivedAsyncTask } from "../background/async-resume.ts";
import { requestChildExecutionCwd } from "../shared/child-execution-cwd.ts";
import {
  readQuestionContract,
  saveQuestionOwner,
  type SupervisorRunContract,
} from "../shared/supervisor-questions.ts";
import { rememberOwnedRun } from "../shared/run-records.ts";
import { resolveRevivalLaunchPolicy } from "./revival-launch-policy.ts";
import { buildManagementControl, formatRunAction } from "../../shared/status-format.ts";
import {
  checkSubagentDepth,
  type AgentConfig,
  type OwnedRun,
  type SubagentState,
  type SavedLaunchConfig,
  type ReadonlyInput,
  type SubagentExecutionResult,
} from "../../shared/types.ts";
import { nestedResolutionScopeForExecutor } from "./execution-routing.ts";
import type { ExecutorDeps, ExecutorReadDeps, SubagentParamsLike } from "./subagent-params.ts";

export interface RevivalInput {
  readonly params: SubagentParamsLike;
  readonly requestCwd: string;
  readonly ctx: ExtensionContext;
  readonly deps: ExecutorDeps;
}
export type RevivalTarget = ReadonlyInput<SupervisorRunContract> & {
  readonly runId: string;
  readonly agent: string;
  readonly index: number;
  readonly source: string;
  readonly cwd?: string;
  readonly sessionFile?: string;
  readonly model?: string;
};
type ReadRevivalInput = Readonly<Omit<RevivalInput, "deps">> & { readonly deps: ExecutorReadDeps };
interface RevivalPlan {
  readonly controlIntercomTarget: string;
  readonly contract: ReadonlyInput<SupervisorRunContract>;
  readonly savedLaunch?: SavedLaunchConfig;
  readonly generatedOutputFilename?: string;
  readonly cwd: string;
  readonly selectedAgent: string;
  readonly agentConfig: AgentConfig;
}
function failure(text: string): SubagentExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: "management", results: [] },
  };
}
function resolveProfile(
  input: ReadRevivalInput,
  target: RevivalTarget,
): RevivalPlan | SubagentExecutionResult {
  const contract = readQuestionContract(target.runId, target.index) ?? target;
  const savedLaunch = savedConfiguration(input.params, contract);
  if (!canReconstruct(input.params, savedLaunch)) {
    return failure(
      `Run '${target.runId}' predates saved launch configuration. Its session and known result remain available, but the original profile cannot be reconstructed safely. Continue with agent: '${target.agent}' to explicitly use that profile's current configuration, including model and thinking; known output and acceptance are retained unless overridden.`,
    );
  }
  const cwd = revivalCwd(input, target, savedLaunch);
  const discovered = savedLaunch
    ? [savedLaunch.agent]
    : input.deps.discoverAgents(cwd, resolveExecutionAgentScope(input.params.agentScope), {
        projectTrusted: input.ctx.isProjectTrusted(),
      }).agents;
  const fallback = resolveIntercomSessionTarget(
    input.deps.pi.getSessionName(),
    input.ctx.sessionManager.getSessionId(),
  );
  const bridge = resolveIntercomBridge(
    resolveOrchestratorIntercomTarget(input.deps.pi.events, fallback),
  );
  const inherited = providerQualifiedModelId(input.ctx.model?.provider, input.ctx.model?.id);
  const selectedAgent = input.params.agent ?? target.agent;
  const profile = discovered.find((agent) => agent.name === selectedAgent);
  if (!profile) {
    return failure(`Unknown agent for resume: ${selectedAgent}`);
  }
  const configured = configuredProfile(profile, savedLaunch, inherited);
  return {
    controlIntercomTarget: bridge.orchestratorTarget,
    contract,
    savedLaunch,
    generatedOutputFilename:
      input.params.output === undefined ? contract.launch?.generatedOutputFilename : undefined,
    cwd,
    selectedAgent,
    agentConfig: configured,
  };
}
function savedConfiguration(
  params: SubagentParamsLike,
  contract: ReadonlyInput<SupervisorRunContract>,
): SavedLaunchConfig | undefined {
  return params.agent === undefined && contract.launch
    ? { ...contract.launch, ...contract.effectiveConfiguration }
    : undefined;
}
function canReconstruct(params: SubagentParamsLike, saved: SavedLaunchConfig | undefined): boolean {
  return saved !== undefined || (params.agent !== undefined && params.agent.length > 0);
}
function revivalCwd(
  input: ReadResumeCwd,
  target: RevivalTarget,
  saved: SavedLaunchConfig | undefined,
): string {
  return input.params.cwd ?? saved?.cwd ?? target.cwd ?? input.requestCwd;
}
type ReadResumeCwd = Readonly<Pick<RevivalInput, "params" | "requestCwd">>;
function configuredProfile(
  profile: AgentConfig,
  saved: SavedLaunchConfig | undefined,
  inherited: string | undefined,
): AgentConfig {
  return saved
    ? {
        ...profile,
        thinking: saved.thinking ?? profile.thinking,
        maxExecutionTimeMs: saved.maxExecutionTimeMs,
        maxTokens: saved.maxTokens,
      }
    : inheritProfileModel(profile, inherited);
}
function inheritProfileModel(profile: AgentConfig, model: string | undefined): AgentConfig {
  return (profile.model !== undefined && profile.model.length > 0) ||
    model === undefined ||
    model.length === 0
    ? profile
    : { ...profile, model };
}
function launchOptions(
  input: ReadRevivalInput & { readonly parentSessionFile: string | null },
  target: RevivalTarget,
  plan: RevivalPlan,
  runId: string,
): Parameters<typeof executeAsyncSingle>[1] {
  const { params, ctx, deps } = input;
  const followUp = (params.message ?? params.task ?? "").trim();

  return {
    agent: plan.selectedAgent,
    task: buildRevivedAsyncTask(target, followUp, params.messageOrigin),
    agentConfig: plan.agentConfig,
    ctx: revivalContext(input),
    cwd: plan.cwd,
    sessionRoot: deps.getSubagentSessionRoot(input.parentSessionFile),
    sessionFile: target.sessionFile,
    controlIntercomTarget: plan.controlIntercomTarget,
    childIntercomTarget: (agent, index) => resolveSubagentIntercomTarget(runId, agent, index),
    availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
    savedLaunch: plan.savedLaunch,
    modelOverride: params.model,
    skills: normalizeSkillInput(params.skill),
    ...resolveRevivalLaunchPolicy({
      params,
      contract: plan.contract,
      saved: plan.savedLaunch,
      generatedOutputFilename: plan.generatedOutputFilename,
      config: deps.config,
      tempArtifactsDir: deps.tempArtifactsDir,
    }),
  };
}
function revivalContext(input: ReadRevivalInput): Parameters<typeof executeAsyncSingle>[1]["ctx"] {
  const currentSessionId = input.deps.state.currentSessionId;
  if (currentSessionId === null) {
    throw new Error("Resume lost its current session identity before launch.");
  }
  return {
    pi: input.deps.pi,
    cwd: input.requestCwd,
    currentSessionId,
    rootSessionId: resolveRootSessionId(input.ctx.sessionManager),
    currentModelProvider: input.ctx.model?.provider,
    projectTrusted: input.ctx.isProjectTrusted(),
  };
}
function launchContinuation(
  runId: string,
  options: Parameters<typeof executeAsyncSingle>[1],
  undo?: () => void,
): SubagentExecutionResult {
  try {
    const result = executeAsyncSingle(runId, options);
    if (result.isError === true) {
      undo?.();
    }
    return result;
  } catch (error) {
    undo?.();
    throw error;
  }
}
function revivalReceipt(
  input: ReadRevivalInput,
  target: RevivalTarget,
  plan: RevivalPlan,
  receipt: { readonly result: SubagentExecutionResult; readonly runId: string },
): SubagentExecutionResult {
  const { result } = receipt;
  const revivedId = result.details.asyncId ?? receipt.runId;
  const revivedTarget = resolveSubagentIntercomTarget(revivedId, plan.selectedAgent, 0);
  const childSafe = nestedResolutionScopeForExecutor(input.deps) !== undefined;
  const prior = input.deps.state.ownedRuns?.get(target.runId);
  const configLabel = configurationLabel(plan.savedLaunch, input.params.model);
  const lines = [
    `Revived ${target.source} subagent from ${target.runId}.`,
    `Run mapping: ${target.runId} -> ${revivedId}`,
    `Revived run: ${revivedId}`,
    `Agent: ${plan.selectedAgent}`,
    `Configuration: ${configLabel}`,
    `Root: ${prior?.rootRunId ?? target.runId}`,
    `Session: ${target.sessionFile ?? "none"}`,
  ];
  if (result.details.asyncDir !== undefined && result.details.asyncDir.length > 0) {
    lines.push(`Async dir: ${result.details.asyncDir}`);
  }
  lines.push(
    `Intercom target: ${revivedTarget} (if registered)`,
    `Prior pending-reply context for ${target.runId} is invalid; use the revived run and target only.`,
    `Status if needed: ${formatRunAction("status", revivedId, {}, childSafe)}`,
  );
  return {
    content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n"), childSafe) }],
    details: {
      ...result.details,
      managementControl: buildManagementControl({
        state: "live",
        runId: revivedId,
        index: 0,
        intercomTarget: revivedTarget,
        canInterrupt: true,
        revivedFromRunId: target.runId,
      }),
    },
  };
}
function usableSessionFile(file: string): boolean {
  return file.length > 0 && path.extname(file) === ".jsonl" && fs.existsSync(file);
}
function initialRevivalRecord(
  input: ReadRevivalInput,
  target: RevivalTarget,
  plan: RevivalPlan,
  receipt: { readonly runId: string; readonly sessionFile: string },
): OwnedRun {
  const prior = input.deps.state.ownedRuns?.get(target.runId);
  const followUp = (input.params.message ?? input.params.task ?? "").trim();
  return {
    runId: receipt.runId,
    ownerSessionId: input.ctx.sessionManager.getSessionId(),
    rootRunId: prior?.rootRunId ?? target.runId,
    predecessorRunId: target.runId,
    predecessorIndex: target.index,
    source: "async",
    mode: "single",
    cwd: plan.cwd,
    task: followUp,
    startedAt: Date.now(),
    children: [
      {
        agent: plan.selectedAgent,
        index: 0,
        task: followUp,
        label: prior?.children.find((child) => child.index === target.index)?.label,
        sessionFile: receipt.sessionFile,
      },
    ],
  };
}
function rememberRevivalReceipt(
  // This persistence boundary updates the actual session-owned run record after launch settles.
  state: SubagentState,
  runId: string,
  result: SubagentExecutionResult,
): void {
  const owned = state.ownedRuns?.get(runId);
  if (owned) {
    rememberOwnedRun(state, {
      ...owned,
      asyncDir: result.details.asyncDir,
      pid: result.details.asyncPid ?? state.asyncJobs.get(runId)?.pid,
      ...(result.isError === true
        ? {
            error: result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
          }
        : {}),
    });
  }
}
function configurationLabel(
  saved: SavedLaunchConfig | undefined,
  model: string | undefined,
): string {
  const label = saved ? "saved effective launch" : "explicitly selected current profile";
  return model !== undefined && model.length > 0 ? `${label}; model ${model}` : label;
}
/** Validate the saved session, persist ownership, launch once, and roll back only the cwd request on failure. */
export function reviveSavedSubagent(
  // Revival owns session identity and durable launch/receipt updates in this dependency boundary.
  input: RevivalInput,
  target: RevivalTarget,
  runId: string = randomUUID(),
): SubagentExecutionResult {
  const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
  const sessionFile = target.sessionFile;
  if (sessionFile === undefined || !usableSessionFile(sessionFile)) {
    return failure(
      `Saved child session file is unavailable: ${sessionFile ?? "none"}. No child was started; any saved answer remains pending.`,
    );
  }
  const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
  if (blocked) {
    return failure(
      `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.`,
    );
  }
  const state = input.deps.state;
  state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
  const plan = resolveProfile(input, target);
  if ("details" in plan) {
    return plan;
  }
  saveQuestionOwner(runId, input.ctx.sessionManager.getSessionId());
  rememberOwnedRun(state, initialRevivalRecord(input, target, plan, { runId, sessionFile }));
  const options = launchOptions({ ...input, parentSessionFile }, target, plan, runId);
  const undo =
    input.params.cwd !== undefined ? requestChildExecutionCwd(sessionFile, plan.cwd) : undefined;
  const result = launchContinuation(runId, options, undo);
  rememberRevivalReceipt(state, runId, result);
  if (result.isError === true) {
    return result;
  }
  return revivalReceipt(input, target, plan, { result, runId });
}
