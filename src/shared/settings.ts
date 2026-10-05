/**
 * Chain behavior, template resolution, and directory management
 */

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
export type {
  ChainStep,
  ParallelStep,
  DynamicParallelStep,
  ParallelTaskItem,
  ResolvedStepBehavior,
  StepOverrides,
  DynamicExpandSpec,
  DynamicParallelTemplate,
  DynamicCollectSpec,
  SequentialStep,
} from "./types/workflow.ts";
import type { ReadonlyInput } from "./types/inputs.ts";
import { normalizeSkillInput } from "../agents/skills.ts";
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

// =============================================================================
// Behavior Resolution Types
// =============================================================================

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

// =============================================================================
// Chain Step Types
// =============================================================================

// Type Guards
// =============================================================================

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

/** Get all agent names in a step (single for sequential, multiple for parallel) */
export function getStepAgents(step: ReadonlyInput<ChainStep>): string[] {
  if (isParallelStep(step)) {
    return step.parallel.map((t) => t.agent);
  }
  if (isDynamicParallelStep(step)) {
    return [step.parallel.agent];
  }
  return [step.agent];
}

export function collectInvocationAgentNames(
  params: ReadonlyInput<{
    agent?: string;
    tasks?: Array<{ agent: string }>;
    chain?: ChainStep[];
  }>,
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

// =============================================================================
// Chain Directory Management
// =============================================================================

// Template Resolution
// =============================================================================

/** Resolved templates for a chain - string for sequential, string[] for parallel */
export type ResolvedTemplates = (string | string[])[];

/**
 * Resolve templates for a chain with parallel step support.
 * Returns string for sequential steps, string[] for parallel steps.
 */
export function resolveChainTemplates(steps: readonly ChainStep[]): ResolvedTemplates {
  return steps.map((step, i) => {
    if (isParallelStep(step)) {
      // Parallel step: resolve each task's template
      return step.parallel.map((task) => {
        if (task.task !== undefined && task.task.length > 0) {
          return task.task;
        }
        // Default for parallel tasks is {previous}
        return "{previous}";
      });
    }
    if (isDynamicParallelStep(step)) {
      return step.parallel.task ?? "{previous}";
    }
    // Sequential step: existing logic
    const seq = step;
    if (seq.task !== undefined && seq.task.length > 0) {
      return seq.task;
    }
    // Default: first step uses {task}, others use {previous}
    return i === 0 ? "{task}" : "{previous}";
  });
}

// =============================================================================
// Behavior Resolution
// =============================================================================

/**
 * Resolve effective chain behavior per step.
 * Priority: step override > agent frontmatter > false (disabled)
 */
export function resolveStepBehavior(
  agentConfig: AgentConfig,
  stepOverrides: StepOverrides,
  chainSkills?: readonly string[] | false,
): ResolvedStepBehavior {
  // Output: step override > frontmatter > false (no output)
  const stepOutput = normalizeOutputOverride(stepOverrides.output);
  const output =
    stepOutput !== undefined ? stepOutput : (normalizeOutputOverride(agentConfig.output) ?? false);

  // Reads: step override > frontmatter defaultReads > false (no reads)
  const reads =
    stepOverrides.reads !== undefined ? stepOverrides.reads : (agentConfig.defaultReads ?? false);

  // Progress: step override > frontmatter defaultProgress > false
  const progress =
    stepOverrides.progress !== undefined
      ? stepOverrides.progress
      : (agentConfig.defaultProgress ?? false);

  const skills = resolveStepSkills(agentConfig.skills, stepOverrides.skills, chainSkills);

  const outputMode = stepOverrides.outputMode ?? "inline";
  const model = stepOverrides.model ?? agentConfig.model;
  return { output, outputMode, reads, progress, skills, model };
}

// Chain Instruction Injection
// =============================================================================

/**
 * Resolve a file path: absolute paths pass through, relative paths get chainDir prepended.
 */
function resolveChainPath(filePath: string, chainDir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(chainDir, filePath);
}

/**
 * Build chain instructions from resolved behavior.
 * These are appended to the task to tell the agent what to read/write.
 */
export function buildChainInstructions(
  behavior: ResolvedStepBehavior,
  chainDir: string,
  isFirstProgressAgent: boolean,
): { prefix: string; suffix: string } {
  const prefixParts: string[] = [];
  const suffixParts: string[] = [];

  // READS - prepend to override any hardcoded filenames in task text
  if (behavior.reads !== false && behavior.reads.length > 0) {
    const files = behavior.reads.map((f) => resolveChainPath(f, chainDir));
    prefixParts.push(`[Read from: ${files.join(", ")}]`);
  }

  // OUTPUT - prepend so agent knows where to write
  if (behavior.output !== false && behavior.output.length > 0) {
    const outputPath = resolveChainPath(behavior.output, chainDir);
    prefixParts.push(`[Write to: ${outputPath}]`);
  }

  // Progress instructions in suffix (less critical)
  if (behavior.progress) {
    const progressPath = path.join(chainDir, "progress.md");
    if (isFirstProgressAgent) {
      suffixParts.push(`Create and maintain progress at: ${progressPath}`);
    } else {
      suffixParts.push(`Update progress at: ${progressPath}`);
    }
  }

  const prefix = prefixParts.length > 0 ? prefixParts.join("\n") + "\n\n" : "";

  const suffix = suffixParts.length > 0 ? "\n\n---\n" + suffixParts.join("\n") : "";

  return { prefix, suffix };
}

// =============================================================================
// Parallel Step Support
// =============================================================================

/**
 * Resolve behaviors for all tasks in a parallel step.
 * Creates namespaced output paths to avoid collisions.
 */
export function resolveParallelBehaviors(
  tasks: readonly ParallelTaskItem[],
  agentConfigs: readonly AgentConfig[],
  stepIndex: number,
  chainSkills?: readonly string[] | false,
): ResolvedStepBehavior[] {
  return tasks.map((task, taskIndex) => {
    const config = agentConfigs.find((a) => a.name === task.agent);
    if (!config) {
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

export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";
