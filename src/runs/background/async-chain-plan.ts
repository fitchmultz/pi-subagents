import * as path from "node:path";
import type { ReadonlyDeep } from "type-fest";
import type {
  AgentConfig,
  ChainStep,
  SequentialStep,
  ParallelStep,
  ParallelTaskItem,
  DynamicParallelStep,
  ResolvedStepBehavior,
  StepOverrides,
  RunnerStep,
  RunnerSubagentStep,
  SubagentRunMode,
} from "../../shared/types.ts";
import {
  buildChainInstructions,
  isParallelStep,
  isDynamicParallelStep,
  resolveParallelBehaviors,
  resolveStepBehavior,
  suppressProgressForReadOnlyTask,
  writeInitialProgressFile,
} from "../../shared/settings.ts";
import {
  buildSkillInjection,
  normalizeSkillInput,
  resolveSkillsWithFallback,
} from "../../agents/skills.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import {
  findDuplicateOutputPath,
  injectSingleOutputInstruction,
  resolveSingleOutputPath,
  validateFileOnlyOutputMode,
} from "../shared/single-output.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import { resolveEffectiveAcceptance } from "../shared/acceptance.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { resolveChildMaxSubagentDepth } from "../../shared/types.ts";
import {
  agentRuntimeFields,
  usesAgentDefaultOutput,
  materializeAsyncDefaultOutput,
  withSavedLaunch,
  resolveLaunchModel,
  UnavailableSubagentSkillError,
  UNAVAILABLE_SUBAGENT_SKILL_ERROR,
  AsyncStartValidationError,
  type AsyncChainParams,
} from "./async-plan.ts";
import { launchErrorMessage } from "./async-launch.ts";

interface ChainWorkspace {
  readonly runnerCwd: string;
  readonly chainDir: string;
  readonly asyncDir: string;
  readonly originalTask?: string;
  readonly resultMode: Exclude<SubagentRunMode, "single">;
  readonly templates: readonly (string | readonly string[])[];
}

interface SequentialOptions {
  readonly sessionFile?: string;
  readonly behaviorCwd?: string;
  readonly progressPrecreated?: boolean;
  readonly behavior?: ResolvedStepBehavior;
}

function stepOverrides(step: SequentialStep): StepOverrides {
  const skills = normalizeSkillInput(step.skill);
  return {
    ...(step.output !== undefined ? { output: step.output } : {}),
    ...(step.outputMode !== undefined ? { outputMode: step.outputMode } : {}),
    ...(step.reads !== undefined ? { reads: step.reads } : {}),
    ...(step.progress !== undefined ? { progress: step.progress } : {}),
    ...(skills !== undefined ? { skills } : {}),
  };
}

/** Owns output numbering, progress admission and continuation-session reservation during chain planning. */
export class AsyncChainPlanner {
  private readonly id: string;
  private readonly params: AsyncChainParams;
  private readonly workspace: ChainWorkspace;
  private progressInstructionCreated = false;
  private outputIndex = 0;
  private sessionIndex = 0;

  constructor(id: string, params: AsyncChainParams, workspace: ChainWorkspace) {
    this.id = id;
    this.params = params;
    this.workspace = workspace;
  }

  build(): RunnerStep[] {
    return this.params.chain.map((step, index) => {
      if (isParallelStep(step)) {
        return this.parallelGroup(step, index);
      }
      if (isDynamicParallelStep(step)) {
        return this.dynamicGroup(step, index);
      }
      return this.sequential(
        { ...step, task: this.sequentialTemplate(index) },
        { sessionFile: this.nextSessionFile() },
      );
    });
  }

  private agent(name: string): ReadonlyDeep<AgentConfig> {
    const agent = this.params.agents.find((candidate) => candidate.name === name);
    if (!agent) {
      throw new AsyncStartValidationError(`Unknown agent: ${name}`);
    }
    return agent;
  }

  private sequentialTemplate(index: number): string {
    const template = this.workspace.templates.at(index);
    if (typeof template !== "string") {
      throw new AsyncStartValidationError(`Missing task template for step ${index + 1}.`);
    }
    return template;
  }

  private systemPrompt(
    agent: ReadonlyDeep<AgentConfig>,
    behavior: ResolvedStepBehavior,
    cwd: string,
  ): Readonly<{ prompt: string; skills: readonly string[] }> {
    const names = behavior.skills === false ? [] : behavior.skills;
    const { resolved, missing } = resolveSkillsWithFallback(names, cwd, this.params.ctx.cwd, {
      projectTrusted: this.params.ctx.projectTrusted ?? true,
    });
    if (missing.includes("pi-subagents")) {
      throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);
    }
    let prompt = agent.systemPrompt?.trim() ?? "";
    if (resolved.length > 0) {
      const injection = buildSkillInjection(resolved);
      prompt = prompt.length > 0 ? `${prompt}\n\n${injection}` : injection;
    }
    return { prompt, skills: resolved.map((skill) => skill.name) };
  }

  private taskInstructions(
    step: SequentialStep,
    behavior: ResolvedStepBehavior,
    input: Readonly<{
      cwd: string;
      output: string | false | undefined;
      progressPrecreated: boolean;
    }>,
  ): Readonly<{ task: string; outputPath?: string }> {
    const read = buildChainInstructions(
      { ...behavior, output: false, progress: false },
      input.cwd,
      false,
    );
    const firstProgress =
      behavior.progress &&
      !input.progressPrecreated &&
      (this.workspace.resultMode !== "chain" || !this.progressInstructionCreated);
    if (behavior.progress && this.workspace.resultMode === "chain") {
      this.progressInstructionCreated = true;
    }
    const progress = buildChainInstructions(
      { ...behavior, output: false, reads: false },
      input.cwd,
      firstProgress,
    );
    const outputPath = resolveSingleOutputPath(input.output, this.params.ctx.cwd, input.cwd);
    const error = validateFileOnlyOutputMode(
      behavior.outputMode,
      outputPath,
      `Async step (${step.agent})`,
    );
    if (error !== undefined && error.length > 0) {
      throw new AsyncStartValidationError(error);
    }
    return {
      task: injectSingleOutputInstruction(
        `${read.prefix}${step.task ?? "{previous}"}${progress.suffix}`,
        outputPath,
      ),
      outputPath,
    };
  }

  private sequential(step: SequentialStep, options: SequentialOptions): RunnerSubagentStep {
    const agent = this.agent(step.agent);
    const outputIndex = this.outputIndex++;
    const cwd = resolveChildCwd(this.workspace.runnerCwd, step.cwd);
    const instructionCwd =
      options.behaviorCwd ??
      (this.workspace.resultMode === "chain" ? this.workspace.chainDir : cwd);
    const behavior = suppressProgressForReadOnlyTask(
      options.behavior ??
        resolveStepBehavior(agent, stepOverrides(step), this.params.chainSkills ?? []),
      step.task,
      this.workspace.originalTask,
    );
    const launchAgent = behavior.skills === false ? { ...agent, inheritSkills: false } : agent;
    const usesDefault = usesAgentDefaultOutput(step.output) || step.outputFromAgentDefault === true;
    const output =
      usesDefault && this.workspace.resultMode !== "chain"
        ? materializeAsyncDefaultOutput({
            output: behavior.output,
            artifactsDir: this.params.artifactsDir,
            asyncDir: this.workspace.asyncDir,
            runId: this.id,
            agent: step.agent,
            index: outputIndex,
          })
        : behavior.output;
    const skills = this.systemPrompt(agent, behavior, cwd);
    const instructions = this.taskInstructions(step, behavior, {
      cwd: instructionCwd,
      output,
      progressPrecreated: options.progressPrecreated === true,
    });
    return withSavedLaunch(
      {
        ...agentRuntimeFields(agent),
        agent: step.agent,
        task: instructions.task,
        phase: step.phase,
        label: step.label,
        outputName: step.as,
        structured: step.outputSchema !== undefined,
        cwd,
        ...resolveLaunchModel(agent, step.model, {
          availableModels: this.params.availableModels,
          preferredProvider: this.params.ctx.currentModelProvider,
        }),
        systemPrompt: skills.prompt,
        inheritSkills: launchAgent.inheritSkills,
        skills: [...skills.skills],
        outputPath: instructions.outputPath,
        output: behavior.output,
        outputMode: behavior.outputMode,
        ...(usesDefault &&
        instructions.outputPath !== undefined &&
        instructions.outputPath.length > 0 &&
        typeof agent.output === "string" &&
        !path.isAbsolute(agent.output)
          ? { outputPathFromAgentDefault: true }
          : {}),
        sessionFile: options.sessionFile,
        maxSubagentDepth: resolveChildMaxSubagentDepth(
          this.params.maxSubagentDepth,
          agent.maxSubagentDepth,
        ),
        effectiveAcceptance: resolveEffectiveAcceptance({ explicit: step.acceptance }),
        ...(step.outputSchema
          ? {
              structuredOutputSchema: step.outputSchema,
              structuredOutput: createStructuredOutputRuntime(
                step.outputSchema,
                path.join(this.workspace.asyncDir, "structured-output"),
              ),
            }
          : {}),
      },
      launchAgent,
      this.params,
    );
  }

  private parallelGroup(group: ParallelStep, stepIndex: number): RunnerStep {
    const templates = this.workspace.templates.at(stepIndex);
    if (templates === undefined || typeof templates === "string") {
      throw new AsyncStartValidationError(
        `Missing parallel task templates for step ${stepIndex + 1}.`,
      );
    }
    const behaviors =
      this.workspace.resultMode === "chain"
        ? resolveParallelBehaviors(
            group.parallel,
            this.params.agents,
            stepIndex,
            this.params.chainSkills ?? [],
          )
        : group.parallel.map((task) =>
            resolveStepBehavior(
              this.agent(task.agent),
              stepOverrides(task),
              this.params.chainSkills ?? [],
            ),
          );
    const resolved = behaviors.map((behavior, index) =>
      suppressProgressForReadOnlyTask(
        behavior,
        group.parallel[index]?.task,
        this.workspace.originalTask,
      ),
    );
    const progressPrecreated =
      this.workspace.resultMode === "chain" && resolved.some((behavior) => behavior.progress);
    if (progressPrecreated) {
      if (group.worktree !== true) {
        writeInitialProgressFile(this.workspace.chainDir);
      }
      this.progressInstructionCreated = true;
    }
    const parallel = group.parallel.map((task, taskIndex) =>
      this.parallelTask(group, task, {
        stepIndex,
        taskIndex,
        template: templates.at(taskIndex),
        behavior: resolved.at(taskIndex),
        progressPrecreated,
      }),
    );
    const error = findDuplicateOutputPath(parallel);
    if (error !== undefined && error.length > 0) {
      throw new AsyncStartValidationError(error);
    }
    return {
      parallel,
      cwd: resolveChildCwd(this.workspace.runnerCwd, group.cwd),
      concurrency: group.concurrency,
      failFast: group.failFast,
      worktree: group.worktree,
    };
  }

  private parallelTask(
    group: ParallelStep,
    task: ParallelTaskItem,
    input: Readonly<{
      stepIndex: number;
      taskIndex: number;
      template?: string;
      behavior?: ResolvedStepBehavior;
      progressPrecreated: boolean;
    }>,
  ): RunnerSubagentStep {
    const cwd = resolveChildCwd(this.workspace.runnerCwd, group.cwd);
    let behaviorCwd: string | undefined;
    if (group.worktree === true && this.workspace.resultMode !== "chain") {
      try {
        behaviorCwd = resolveExpectedWorktreeAgentCwd(
          cwd,
          `${this.id}-s${input.stepIndex}`,
          input.taskIndex,
        );
      } catch {
        /* Setup will report unusable worktrees; instructions fall back to the launch cwd. */
      }
    }
    const precreated =
      input.progressPrecreated ||
      (this.workspace.resultMode !== "chain" &&
        input.behavior?.progress === true &&
        group.worktree !== true);
    if (precreated && !input.progressPrecreated) {
      const progressCwd = resolveChildCwd(cwd, task.cwd);
      try {
        writeInitialProgressFile(progressCwd);
      } catch (error) {
        throw new AsyncStartValidationError(
          `Failed to initialize progress in '${progressCwd}': ${launchErrorMessage(error)}`,
          { cause: error },
        );
      }
    }
    return this.sequential(
      { ...task, task: input.template, cwd: resolveChildCwd(cwd, task.cwd) },
      {
        sessionFile: this.nextSessionFile(),
        behaviorCwd,
        progressPrecreated: precreated,
        behavior: input.behavior,
      },
    );
  }

  private dynamicGroup(group: DynamicParallelStep, stepIndex: number): RunnerStep {
    const agent = this.agent(group.parallel.agent);
    const behavior = suppressProgressForReadOnlyTask(
      resolveStepBehavior(agent, stepOverrides(group.parallel), this.params.chainSkills ?? []),
      group.parallel.task,
      this.workspace.originalTask,
    );
    if (behavior.progress) {
      writeInitialProgressFile(this.workspace.chainDir);
      this.progressInstructionCreated = true;
    }
    const count = group.expand.maxItems ?? this.params.dynamicFanoutMaxItems ?? 0;
    return {
      expand: group.expand,
      parallel: this.sequential(
        { ...group.parallel, task: this.sequentialTemplate(stepIndex) },
        { progressPrecreated: behavior.progress, behavior },
      ),
      collect: group.collect,
      concurrency: group.concurrency,
      failFast: group.failFast,
      phase: group.phase,
      label: group.label,
      sessionFiles: this.takeDynamicSessions(count),
    };
  }

  private nextSessionFile(): string | undefined {
    const file = this.params.sessionFilesByFlatIndex?.[this.sessionIndex];
    this.sessionIndex++;
    return file;
  }

  private takeDynamicSessions(count: number): Array<string | undefined> | undefined {
    const files = this.params.sessionFilesByFlatIndex;
    if (files === undefined || count <= 0) {
      return;
    }
    const selected = files.slice(this.sessionIndex, this.sessionIndex + count);
    this.sessionIndex += count;
    return selected;
  }
}
