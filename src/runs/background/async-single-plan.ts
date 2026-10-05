import * as path from "node:path";
import {
  type AgentConfig,
  type RunnerSubagentStep,
  resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import type { ReadonlyDeep } from "type-fest";
import { buildChainInstructions, writeInitialProgressFile } from "../../shared/settings.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import {
  injectSingleOutputInstruction,
  resolveSingleOutputPath,
  validateFileOnlyOutputMode,
} from "../shared/single-output.ts";
import { resolveEffectiveAcceptance } from "../shared/acceptance.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import {
  agentRuntimeFields,
  usesAgentDefaultOutput,
  resolveAsyncOutput,
  withSavedLaunch,
  resolveLaunchModel,
  UNAVAILABLE_SUBAGENT_SKILL_ERROR,
  UnavailableSubagentSkillError,
  AsyncStartValidationError,
  type AsyncSingleParams,
} from "./async-plan.ts";

function singleSkills(
  params: Pick<AsyncSingleParams, "skills" | "savedLaunch" | "agentConfig" | "ctx">,
  cwd: string,
): Readonly<{ launchAgent: ReadonlyDeep<AgentConfig>; prompt: string; skills: readonly string[] }> {
  const agent = params.agentConfig;
  const launchAgent = params.skills === false ? { ...agent, inheritSkills: false } : agent;
  if (params.savedLaunch && params.skills === undefined) {
    return {
      launchAgent,
      prompt: params.savedLaunch.systemPrompt,
      skills: params.savedLaunch.skills,
    };
  }
  const names = skillNames(params.skills, agent.skills);
  const { resolved, missing } = resolveSkillsWithFallback(names, cwd, params.ctx.cwd, {
    projectTrusted: params.ctx.projectTrusted ?? true,
  });
  if (missing.includes("pi-subagents")) {
    throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);
  }
  let prompt = agent.systemPrompt.trim();
  if (resolved.length > 0) {
    const injection = buildSkillInjection(resolved);
    prompt = prompt.length > 0 ? `${prompt}\n\n${injection}` : injection;
  }
  return { launchAgent, prompt, skills: resolved.map((skill) => skill.name) };
}

function skillNames(
  explicit: readonly string[] | false | undefined,
  defaults: readonly string[] | undefined,
): readonly string[] {
  return explicit === false ? [] : (explicit ?? defaults ?? []);
}

function defaultOutputMarker(
  output: string | false | undefined,
  outputPath: string | undefined,
  usesDefault: boolean,
): true | undefined {
  if (!usesDefault || outputPath === undefined || outputPath.length === 0) {
    return;
  }
  if (typeof output !== "string" || path.isAbsolute(output)) {
    return;
  }
  return true;
}

function singleOutput(
  id: string,
  params: AsyncSingleParams,
  cwd: string,
  asyncDir: string,
): Readonly<{ task: string; outputPath?: string; outputFromDefault?: true }> {
  const defaultOutput = params.generatedOutputFilename ?? params.agentConfig.output;
  const output = resolveAsyncOutput({
    requestedOutput: params.output,
    agentDefaultOutput: defaultOutput,
    artifactsDir: params.artifactsDir,
    asyncDir,
    runId: id,
    agent: params.agent,
    index: 0,
  });
  const outputPath = resolveSingleOutputPath(output, params.ctx.cwd, cwd);
  const error = validateFileOnlyOutputMode(
    params.outputMode ?? "inline",
    outputPath,
    `Async single run (${params.agent})`,
  );
  if (error !== undefined && error.length > 0) {
    throw new AsyncStartValidationError(error);
  }
  let task = params.task ?? "";
  if (params.progress === true) {
    writeInitialProgressFile(cwd);
    task += buildChainInstructions(
      { output: false, outputMode: "inline", reads: false, progress: true, skills: false },
      cwd,
      true,
    ).suffix;
  }
  const usesDefault =
    usesAgentDefaultOutput(params.output) || params.outputFromAgentDefault === true;
  const outputFromDefault = defaultOutputMarker(defaultOutput, outputPath, usesDefault);
  return {
    task: injectSingleOutputInstruction(task, outputPath),
    outputPath,
    ...(outputFromDefault === true ? { outputFromDefault: true } : {}),
  };
}

/** Resolves the saved launch, output contract and skill scope for one detached child. */
export function planAsyncSingle(
  id: string,
  params: AsyncSingleParams,
  workspace: Readonly<{ cwd: string; asyncDir: string }>,
): RunnerSubagentStep {
  const agent = params.agentConfig;
  const skills = singleSkills(params, workspace.cwd);
  const output = singleOutput(id, params, workspace.cwd, workspace.asyncDir);
  return withSavedLaunch(
    {
      ...agentRuntimeFields(agent),
      agent: params.agent,
      task: output.task,
      cwd: workspace.cwd,
      ...resolveLaunchModel(agent, params.modelOverride, {
        availableModels: params.availableModels,
        preferredProvider: params.ctx.currentModelProvider,
        savedLaunch: params.savedLaunch,
      }),
      systemPrompt: skills.prompt,
      inheritSkills: skills.launchAgent.inheritSkills,
      skills: [...skills.skills],
      outputPath: output.outputPath,
      outputMode: params.outputMode ?? "inline",
      ...(output.outputFromDefault === true ? { outputPathFromAgentDefault: true } : {}),
      ...(params.outputSchema
        ? {
            structuredOutputSchema: params.outputSchema,
            structuredOutput: createStructuredOutputRuntime(
              params.outputSchema,
              path.join(workspace.asyncDir, "structured-output"),
            ),
          }
        : {}),
      sessionFile: params.sessionFile,
      maxSubagentDepth: resolveChildMaxSubagentDepth(
        params.maxSubagentDepth,
        agent.maxSubagentDepth,
      ),
      effectiveAcceptance: resolveEffectiveAcceptance({ explicit: params.acceptance }),
    },
    skills.launchAgent,
    params,
    params.generatedOutputFilename,
  );
}
