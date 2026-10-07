/** Chain step traversal, behavior resolution, and instruction composition. */
import * as path from "node:path";
import type { AgentConfig } from "./types/config.ts";
import type {
  ChainStep,
  ParallelStep,
  DynamicParallelStep,
  ParallelTaskItem,
  ResolvedStepBehavior,
  StepOverrides,
} from "./types/workflow.ts";
import type { ReadonlyInput } from "./types/inputs.ts";
import { normalizeSkillInput } from "../agents/skills.ts";
export type {
  ChainStep,
  ParallelStep,
  DynamicParallelStep,
  SequentialStep,
  ParallelTaskItem,
  ResolvedStepBehavior,
  StepOverrides,
  DynamicExpandSpec,
  DynamicParallelTemplate,
  DynamicCollectSpec,
} from "./types/workflow.ts";
export {
  createChainDir,
  removeChainDir,
  cleanupOldChainDirs,
  writeInitialProgressFile,
} from "./chain-files.ts";
export {
  resolveTaskTextForFileUpdatePolicy,
  taskDisallowsFileUpdates,
  suppressProgressForReadOnlyTask,
} from "./task-file-policy.ts";
export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";

export function isParallelStep(
  step: ReadonlyInput<ChainStep>,
): step is ReadonlyInput<ParallelStep> {
  return "parallel" in step && Array.isArray(step.parallel);
}
export function isDynamicParallelStep(
  step: ReadonlyInput<ChainStep>,
): step is ReadonlyInput<DynamicParallelStep> {
  return (
    "expand" in step && "collect" in step && "parallel" in step && !Array.isArray(step.parallel)
  );
}
export function getStepAgents(step: ReadonlyInput<ChainStep>): string[] {
  if (isParallelStep(step)) {
    return step.parallel.map((task) => task.agent);
  }
  if (isDynamicParallelStep(step)) {
    return [step.parallel.agent];
  }
  return [step.agent];
}
export function collectInvocationAgentNames(
  params: ReadonlyInput<{ agent?: string; tasks?: Array<{ agent: string }>; chain?: ChainStep[] }>,
): string[] {
  const names: string[] = [];
  if (params.agent !== undefined && params.agent.length > 0) {
    names.push(params.agent);
  }
  for (const task of params.tasks ?? []) {
    names.push(task.agent);
  }
  for (const step of params.chain ?? []) {
    names.push(...getStepAgents(step));
  }
  return names;
}
export type ResolvedTemplates = (string | string[])[];
export function resolveChainTemplates(steps: readonly ChainStep[]): ResolvedTemplates {
  return steps.map((step, index) => {
    if (isParallelStep(step)) {
      return step.parallel.map((task) =>
        task.task !== undefined && task.task.length > 0 ? task.task : "{previous}",
      );
    }
    if (isDynamicParallelStep(step)) {
      return step.parallel.task ?? "{previous}";
    }
    if (step.task !== undefined && step.task.length > 0) {
      return step.task;
    }
    return index === 0 ? "{task}" : "{previous}";
  });
}
function normalizeOutputOverride(output: string | false | undefined): string | false | undefined {
  return output === "false" ? false : output;
}
function resolveStepSkills(
  agentSkills: readonly string[] | undefined,
  overrideSkills: readonly string[] | false | undefined,
  chainSkills: readonly string[] | false | undefined,
): string[] | false {
  if (chainSkills === false || overrideSkills === false) {
    return false;
  }
  const skills = [...(overrideSkills ?? agentSkills ?? [])];
  return chainSkills !== undefined && chainSkills.length > 0
    ? [...new Set([...skills, ...chainSkills])]
    : skills;
}
/** Per-field precedence: step override, agent defaults, then disabled/unset. */
export function resolveStepBehavior(
  agentConfig: AgentConfig,
  stepOverrides: StepOverrides,
  chainSkills?: readonly string[] | false,
): ResolvedStepBehavior {
  return {
    output:
      normalizeOutputOverride(stepOverrides.output) ??
      normalizeOutputOverride(agentConfig.output) ??
      false,
    outputMode: stepOverrides.outputMode ?? "inline",
    reads: stepOverrides.reads ?? agentConfig.defaultReads ?? false,
    progress: stepOverrides.progress ?? agentConfig.defaultProgress ?? false,
    skills: resolveStepSkills(agentConfig.skills, stepOverrides.skills, chainSkills),
    model: stepOverrides.model ?? agentConfig.model,
  };
}
function resolveChainPath(filePath: string, chainDir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(chainDir, filePath);
}
/** Prepend read/output paths so task prose cannot accidentally override the chosen destination. */
export function buildChainInstructions(
  behavior: ResolvedStepBehavior,
  chainDir: string,
  isFirstProgressAgent: boolean,
): { prefix: string; suffix: string } {
  const prefixParts: string[] = [];
  const suffixParts: string[] = [];
  if (behavior.reads !== false && behavior.reads.length > 0) {
    prefixParts.push(
      `[Read from: ${behavior.reads.map((file) => resolveChainPath(file, chainDir)).join(", ")}]`,
    );
  }
  if (behavior.output !== false && behavior.output.length > 0) {
    prefixParts.push(`[Write to: ${resolveChainPath(behavior.output, chainDir)}]`);
  }
  if (behavior.progress) {
    const progressPath = path.join(chainDir, "progress.md");
    suffixParts.push(
      isFirstProgressAgent
        ? `Create and maintain progress at: ${progressPath}`
        : `Update progress at: ${progressPath}`,
    );
  }
  return {
    prefix: prefixParts.length > 0 ? `${prefixParts.join("\n")}\n\n` : "",
    suffix: suffixParts.length > 0 ? `\n\n---\n${suffixParts.join("\n")}` : "",
  };
}
export function resolveParallelBehaviors(
  tasks: readonly ParallelTaskItem[],
  agentConfigs: readonly AgentConfig[],
  stepIndex: number,
  chainSkills?: readonly string[] | false,
): ResolvedStepBehavior[] {
  return tasks.map((task, taskIndex) => {
    const config = agentConfigs.find((agent) => agent.name === task.agent);
    if (config === undefined) {
      throw new Error(`Unknown agent: ${task.agent}`);
    }
    const behavior = resolveStepBehavior(
      config,
      {
        output: task.output,
        outputMode: task.outputMode,
        reads: task.reads,
        progress: task.progress,
        skills: normalizeSkillInput(task.skill),
        model: task.model,
      },
      chainSkills,
    );
    return {
      ...behavior,
      output: namespaceParallelOutput(behavior.output, task.agent, stepIndex, taskIndex),
    };
  });
}
export function namespaceParallelOutput(
  output: string | false | undefined,
  agent: string,
  stepIndex: number,
  taskIndex: number,
): string | false {
  if (output === undefined || output === false || output.length === 0) {
    return false;
  }
  return path.isAbsolute(output)
    ? output
    : path.join(`parallel-${stepIndex}`, `${taskIndex}-${agent}`, output);
}
