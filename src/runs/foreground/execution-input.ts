import * as path from "node:path";
import type { ChainStep, ResolvedStepBehavior } from "../../shared/types/workflow.ts";
import { errorMessage } from "../../shared/unknown.ts";
import type { AgentConfig } from "../../shared/types/config.ts";
import { getStepAgents, isParallelStep, isDynamicParallelStep } from "../../shared/settings.ts";
import { findDuplicateOutputPath, resolveSingleOutputPath } from "../shared/single-output.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { validateAcceptanceInput } from "../shared/acceptance.ts";
import {
  findWorktreeTaskCwdConflict,
  formatWorktreeTaskCwdConflict,
  type WorktreeSetup,
} from "../shared/worktree.ts";
import type { Details, SubagentExecutionResult, ReadonlyInput } from "../../shared/types.ts";
import type { SubagentParamsLike, TaskParam } from "./subagent-params.ts";
import { resolveForegroundTimeoutMs } from "./execution-timeout.ts";
export { resolveForegroundTimeoutMs, normalizeRoleForegroundTimeout } from "./execution-timeout.ts";
export { normalizeRepeatedParallelCounts } from "./invocation-expansion.ts";

function validationError(mode: Details["mode"], text: string): SubagentExecutionResult {
  return { content: [{ type: "text", text }], isError: true, details: { mode, results: [] } };
}
function acceptanceForStep(step: ChainStep, index: number): string | undefined {
  const prefix = `chain[${index}]`;
  if (isParallelStep(step)) {
    if (Object.hasOwn(step, "acceptance")) {
      return `${prefix}.acceptance is not supported on static parallel groups; set acceptance on each parallel task.`;
    }
    for (const [taskIndex, task] of step.parallel.entries()) {
      const errors = validateAcceptanceInput(
        task.acceptance,
        `${prefix}.parallel[${taskIndex}].acceptance`,
      );
      if (errors.length > 0) {
        return errors.join(" ");
      }
    }
    return;
  }
  if (isDynamicParallelStep(step)) {
    if (Object.hasOwn(step, "acceptance")) {
      return `${prefix}.acceptance is not supported on dynamic fanout groups; set acceptance on ${prefix}.parallel.acceptance for each materialized child.`;
    }
    const errors = validateAcceptanceInput(
      step.parallel.acceptance,
      `${prefix}.parallel.acceptance`,
    );
    return errors.length > 0 ? errors.join(" ") : undefined;
  }
  const errors = validateAcceptanceInput(step.acceptance, `${prefix}.acceptance`);
  return errors.length > 0 ? errors.join(" ") : undefined;
}
function validateAcceptance(params: SubagentParamsLike): SubagentExecutionResult | undefined {
  const errors = validateAcceptanceInput(params.acceptance);
  if (errors.length > 0) {
    return validationError("single", errors.join(" "));
  }
  for (const [index, task] of (params.tasks ?? []).entries()) {
    const taskErrors = validateAcceptanceInput(task.acceptance, `tasks[${index}].acceptance`);
    if (taskErrors.length > 0) {
      return validationError("parallel", taskErrors.join(" "));
    }
  }
  for (const [index, step] of (params.chain ?? []).entries()) {
    const error = acceptanceForStep(step, index);
    if (error !== undefined) {
      return validationError("chain", error);
    }
  }
  return;
}
interface InvocationModes {
  readonly hasChain: boolean;
  readonly hasTasks: boolean;
  readonly hasSingle: boolean;
  readonly allowClarifyTaskPrompt: boolean;
}
function validateMode(
  params: SubagentParamsLike,
  agents: readonly AgentConfig[],
  modes: InvocationModes,
): SubagentExecutionResult | undefined {
  if (params.tasks?.length === 0) {
    return validationError("parallel", "tasks must contain at least one task.");
  }
  if (params.worktree !== undefined && !modes.hasTasks) {
    return validationError(
      getRequestedModeLabel(params),
      "Top-level worktree is supported only with tasks parallel mode.",
    );
  }
  if (modes.hasSingle && params.task !== undefined && invalidTask(params.task)) {
    return validationError("single", "task must be a non-empty string when provided.");
  }
  if (Number(modes.hasChain) + Number(modes.hasTasks) + Number(modes.hasSingle) !== 1) {
    const names = agents.map((agent) => agent.name).join(", ");
    return validationError(
      "single",
      `Provide exactly one mode. Agents: ${names.length > 0 ? names : "none"}`,
    );
  }
  return;
}
export function validateExecutionInput(
  params: SubagentParamsLike,
  agents: readonly AgentConfig[],
  modes: InvocationModes,
): SubagentExecutionResult | null {
  const error = validateAcceptance(params) ?? validateMode(params, agents, modes);
  if (error) {
    return error;
  }
  const timeout = resolveForegroundTimeoutMs(params);
  if (timeout.error !== undefined) {
    return validationError(getRequestedModeLabel(params), timeout.error);
  }
  const agentError = modes.hasSingle ? validateSingleAgent(params.agent, agents) : undefined;
  if (agentError) {
    return agentError;
  }
  if (modes.hasTasks && params.tasks) {
    return validateTasks(params.tasks, agents);
  }
  if (modes.hasChain && params.chain) {
    return validateChain(params, agents, modes.allowClarifyTaskPrompt);
  }
  return null;
}
function validateSingleAgent(
  name: string | undefined,
  agents: readonly AgentConfig[],
): SubagentExecutionResult | undefined {
  if (name !== undefined && name.length > 0 && !agents.some((agent) => agent.name === name)) {
    return validationError("single", `Unknown agent: ${name}`);
  }
  return;
}
function invalidTask(task: unknown): boolean {
  return typeof task !== "string" || task.trim().length === 0;
}
function validateTasks(
  tasks: readonly TaskParam[],
  agents: readonly AgentConfig[],
): SubagentExecutionResult | null {
  for (const [index, task] of tasks.entries()) {
    if (invalidTask(task.task)) {
      return validationError("parallel", `tasks[${index}].task must be a non-empty string.`);
    }
    if (!agents.some((agent) => agent.name === task.agent)) {
      return validationError("parallel", `Unknown agent: ${task.agent} (task ${index + 1})`);
    }
  }
  return null;
}
function firstStepError(
  step: ChainStep,
  params: SubagentParamsLike,
  clarify: boolean,
): string | undefined {
  if (isParallelStep(step)) {
    const missing = step.parallel.findIndex(
      (task) => task.task === undefined || task.task.length === 0,
    );
    return missing < 0
      ? undefined
      : `First parallel step: task ${missing + 1} must have a task (no previous output to reference)`;
  }
  if (isDynamicParallelStep(step)) {
    return "First step in chain cannot be dynamic fanout; expand.from requires a prior structured named output";
  }
  if (
    (step.task === undefined || step.task.length === 0) &&
    (params.task === undefined || params.task.length === 0) &&
    !clarify
  ) {
    return "First step in chain must have a task";
  }
  return;
}
const SEQUENTIAL_KEYS = new Set([
  "agent",
  "task",
  "phase",
  "label",
  "as",
  "outputSchema",
  "cwd",
  "output",
  "outputMode",
  "reads",
  "progress",
  "skill",
  "model",
  "acceptance",
]);
const PARALLEL_KEYS = new Set(["parallel", "concurrency", "failFast", "worktree", "cwd"]);
const DYNAMIC_KEYS = new Set([
  "expand",
  "parallel",
  "collect",
  "concurrency",
  "failFast",
  "phase",
  "label",
]);
function allowedStepKeys(step: ChainStep): ReadonlySet<string> {
  if (isParallelStep(step)) {
    return PARALLEL_KEYS;
  }
  return isDynamicParallelStep(step) ? DYNAMIC_KEYS : SEQUENTIAL_KEYS;
}
function stepTaskError(step: ChainStep, index: number): string | undefined {
  if ("task" in step && Object.hasOwn(step, "task") && invalidTask(step.task)) {
    return `chain[${index}].task must be a non-empty string when provided.`;
  }
  if (isParallelStep(step)) {
    const empty = step.parallel.findIndex(
      (task) => Object.hasOwn(task, "task") && invalidTask(task.task),
    );
    if (empty >= 0) {
      return `chain[${index}].parallel[${empty}].task must be a non-empty string when provided.`;
    }
  }
  if (
    isDynamicParallelStep(step) &&
    Object.hasOwn(step.parallel, "task") &&
    invalidTask(step.parallel.task)
  ) {
    return `chain[${index}].parallel.task must be a non-empty string when provided.`;
  }
  return;
}
function validateChain(
  params: SubagentParamsLike,
  agents: readonly AgentConfig[],
  clarify: boolean,
): SubagentExecutionResult | null {
  const chain = params.chain ?? [];
  const first = chain.at(0);
  if (!first) {
    return validationError("chain", "Chain must have at least one step");
  }
  const firstError = firstStepError(first, params, clarify);
  if (firstError !== undefined) {
    return validationError("chain", firstError);
  }
  for (const [index, step] of chain.entries()) {
    const allowed = allowedStepKeys(step);
    const unsupported = Object.keys(step).filter((key) => !allowed.has(key));
    if (unsupported.length > 0) {
      return validationError(
        "chain",
        `chain[${index}] fields are not supported for this step mode: ${unsupported.join(", ")}.`,
      );
    }
    const taskError = stepTaskError(step, index);
    if (taskError !== undefined) {
      return validationError("chain", taskError);
    }
    const missing = getStepAgents(step).find(
      (name) => !agents.some((agent) => agent.name === name),
    );
    if (missing !== undefined) {
      return validationError("chain", `Unknown agent: ${missing} (step ${index + 1})`);
    }
    if (isParallelStep(step) && step.parallel.length === 0) {
      return validationError("chain", `Parallel step ${index + 1} must have at least one task`);
    }
  }
  return null;
}
function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
  if ((params.chain?.length ?? 0) > 0) {
    return "chain";
  }
  if ((params.tasks?.length ?? 0) > 0) {
    return "parallel";
  }
  return "single";
}
export function buildRequestedModeError(
  params: SubagentParamsLike,
  message: string,
): SubagentExecutionResult {
  return withForkContext(validationError(getRequestedModeLabel(params), message), params.context);
}
export function withForkContext(
  result: SubagentExecutionResult,
  context: SubagentParamsLike["context"],
): SubagentExecutionResult {
  if (context !== "fork") {
    return result;
  }
  return { ...result, details: { ...result.details, context: "fork" } };
}
export function toExecutionErrorResult(
  params: SubagentParamsLike,
  error: unknown,
  context: SubagentParamsLike["context"] = params.context,
): SubagentExecutionResult {
  const message = errorMessage(error);
  return withForkContext(validationError(getRequestedModeLabel(params), message), context);
}
function sessionAgents(step: ChainStep, maximum: number): readonly (string | undefined)[] {
  if (isParallelStep(step)) {
    return step.parallel.map((task) => task.agent);
  }
  if (isDynamicParallelStep(step)) {
    return Array.from({ length: step.expand.maxItems ?? maximum }, () => step.parallel.agent);
  }
  return [getStepAgents(step)[0]];
}
export function collectChainSessionFiles(
  chain: readonly ChainStep[],
  sessionFileForIndex: (index?: number) => string | undefined,
  sessionFileForAgentIndex: (agent: string | undefined, index?: number) => string | undefined,
  dynamicFanoutMaxItems = 0,
): (string | undefined)[] {
  return chain
    .flatMap((step) => sessionAgents(step, dynamicFanoutMaxItems))
    .map((agent, index) => sessionFileForAgentIndex(agent, index) ?? sessionFileForIndex(index));
}
export function buildParallelModeError(message: string): SubagentExecutionResult {
  return validationError("parallel", message);
}
export function buildParallelWorktreeTaskCwdError(
  tasks: ReadonlyArray<{ readonly agent: string; readonly cwd?: string }>,
  sharedCwd: string,
): string | undefined {
  const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
  return conflict ? formatWorktreeTaskCwdConflict(conflict, sharedCwd) : undefined;
}
export function buildChainWorktreeTaskCwdError(
  chain: readonly ChainStep[],
  sharedCwd: string,
): string | undefined {
  for (const [index, step] of chain.entries()) {
    if (!isParallelStep(step) || step.worktree !== true) {
      continue;
    }
    const cwd = resolveChildCwd(sharedCwd, step.cwd);
    const conflict = findWorktreeTaskCwdConflict(step.parallel, cwd);
    if (conflict) {
      return `parallel chain step ${index + 1}: ${formatWorktreeTaskCwdConflict(conflict, cwd)}`;
    }
  }
  return;
}
export function resolveParallelTaskCwd(
  task: TaskParam,
  cwd: string,
  worktree: ReadonlyInput<WorktreeSetup> | undefined,
  index: number,
): string {
  if (!worktree) {
    return resolveChildCwd(cwd, task.cwd);
  }
  const assigned = worktree.worktrees.at(index);
  if (!assigned) {
    throw new Error(`Missing worktree assignment for child ${index}.`);
  }
  return assigned.agentCwd;
}
export function findDuplicateParallelOutputPath(input: {
  readonly tasks: readonly TaskParam[];
  readonly behaviors: readonly ResolvedStepBehavior[];
  readonly paramsCwd: string;
  readonly ctxCwd: string;
  readonly worktreeSetup?: ReadonlyInput<WorktreeSetup>;
}): string | undefined {
  return findDuplicateOutputPath(
    input.tasks.map((task, index) => {
      const output = input.behaviors.at(index)?.output;
      if (output === false || output === undefined || output.length === 0) {
        return { agent: task.agent };
      }
      return {
        agent: task.agent,
        outputPath: resolveSingleOutputPath(
          output,
          input.ctxCwd,
          resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index),
        ),
      };
    }),
  );
}
export function findDuplicateAbsoluteParallelOutputPath(input: {
  readonly tasks: readonly TaskParam[];
  readonly behaviors: readonly ResolvedStepBehavior[];
}): string | undefined {
  return findDuplicateOutputPath(
    input.tasks.map((task, index) => {
      const output = input.behaviors.at(index)?.output;
      if (typeof output !== "string" || !path.isAbsolute(output)) {
        return { agent: task.agent };
      }
      return { agent: task.agent, outputPath: path.resolve(output) };
    }),
  );
}
