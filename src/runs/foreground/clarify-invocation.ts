import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../shared/types/config.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { validateForkContextModelPolicy } from "../../shared/agent-context-policy.ts";
import { toModelInfo } from "../../shared/model-info.ts";
import {
  createChainDir,
  isDynamicParallelStep,
  isParallelStep,
  removeChainDir,
  resolveChainTemplates,
  resolveStepBehavior,
  type SequentialStep,
} from "../../shared/settings.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { normalizeSingleOutputOverride } from "../shared/single-output.ts";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import type { SubagentParamsLike, TaskParam } from "./subagent-params.ts";

type ClarifyStep = Omit<TaskParam, "task"> & { readonly task?: string };
function previewSteps(params: SubagentParamsLike): readonly ClarifyStep[] {
  if (params.chain) {
    return params.chain.map((step) => {
      if (isParallelStep(step) || isDynamicParallelStep(step)) {
        throw new Error("Parallel groups cannot use the sequential preview.");
      }
      return step;
    });
  }
  if (params.tasks) {
    return params.tasks;
  }
  if (params.agent === undefined) {
    throw new Error("Clarification requires an agent.");
  }
  return [{ ...params, agent: params.agent }];
}
function applyPreview(step: ClarifyStep, result: ChainClarifyResult, index: number): ClarifyStep {
  const override = result.behaviorOverrides[index];
  const updated = { ...step, task: result.templates[index] ?? "" };
  return Object.assign(updated, overrideFields(override));
}
function overrideFields(
  override: ChainClarifyResult["behaviorOverrides"][number],
): Partial<ClarifyStep> {
  if (!override) {
    return {};
  }
  return {
    ...(override.model !== undefined && override.model.length > 0 ? { model: override.model } : {}),
    ...(override.output !== undefined ? { output: override.output } : {}),
    ...(override.reads !== undefined
      ? { reads: override.reads === false ? false : [...override.reads] }
      : {}),
    ...(override.progress !== undefined ? { progress: override.progress } : {}),
    ...(override.skills !== undefined
      ? { skill: override.skills === false ? false : [...override.skills] }
      : {}),
  };
}
function applyInvocationPreview(
  params: SubagentParamsLike,
  result: ChainClarifyResult,
): SubagentParamsLike {
  const updated = previewSteps(params).map((step, index) => applyPreview(step, result, index));
  const confirmed = { clarify: false, async: result.runInBackground === true };
  if (params.chain) {
    return { ...params, chain: updated.map(toSequentialStep), ...confirmed };
  }
  if (params.tasks) {
    return {
      ...params,
      tasks: updated.map((step) => ({ ...step, task: step.task ?? "" })),
      ...confirmed,
    };
  }
  return { ...params, ...updated[0], ...confirmed };
}

/** Preview changes launch input only; waiting and background runs share the same owner. */
function toSequentialStep(step: ClarifyStep): SequentialStep {
  return {
    ...step,
    output: step.output === true ? undefined : step.output,
    reads: step.reads === true ? undefined : step.reads,
    skill: step.skill === true ? undefined : step.skill,
  };
}
function sequentialTemplates(params: SubagentParamsLike, steps: readonly ClarifyStep[]): string[] {
  if (!params.chain) {
    return steps.map((step) => step.task ?? "");
  }
  return resolveChainTemplates(params.chain).map((template) => {
    if (typeof template !== "string") {
      throw new Error("Sequential preview received parallel templates.");
    }
    return template;
  });
}
function preparePreview(params: SubagentParamsLike, agents: readonly AgentConfig[]) {
  const steps = previewSteps(params);
  const profiles = steps.map((step) => {
    const profile = agents.find((agent) => agent.name === step.agent);
    if (!profile) {
      throw new Error(`Unknown agent: ${step.agent}`);
    }
    return profile;
  });
  let mode: "single" | "parallel" | "chain" = "single";
  if (params.chain) {
    mode = "chain";
  } else if (params.tasks) {
    mode = "parallel";
  }
  const templates = sequentialTemplates(params, steps);
  const chainSkills = mode === "chain" ? (normalizeSkillInput(params.skill) ?? []) : [];
  const behaviors = steps.map((step, index) => {
    const profile = profiles.at(index);
    if (!profile) {
      throw new Error(`Missing profile for clarification step ${index}.`);
    }
    return resolveStepBehavior(
      profile,
      {
        output: normalizeSingleOutputOverride(step.output, profile.output),
        outputMode: step.outputMode,
        reads: step.reads === true ? undefined : step.reads,
        progress: step.progress,
        skills: normalizeSkillInput(step.skill),
        model: step.model,
      },
      chainSkills,
    );
  });
  return {
    mode,
    profiles,
    templates,
    behaviors,
    originalTask: params.task ?? (mode === "chain" ? (templates[0] ?? "") : ""),
  };
}
export function canClarifyInvocation(params: SubagentParamsLike, ctx: ExtensionContext): boolean {
  return (
    params.clarify === true &&
    ctx.hasUI &&
    ctx.mode === "tui" &&
    params.chain?.some((step) => isParallelStep(step) || isDynamicParallelStep(step)) !== true
  );
}
export async function clarifyInvocation(input: {
  readonly params: SubagentParamsLike;
  readonly agents: readonly AgentConfig[];
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly runId: string;
}): Promise<SubagentParamsLike | undefined> {
  const { params, agents, ctx, cwd, runId } = input;
  if (!canClarifyInvocation(params, ctx)) {
    return params;
  }
  const preview = preparePreview(params, agents);
  const models = ctx.modelRegistry.getAvailable().map(toModelInfo);
  const skills = discoverAvailableSkills(cwd, { projectTrusted: ctx.isProjectTrusted() });
  const chainDir =
    preview.mode === "chain" ? createChainDir(runId, params.chainDir, cwd) : undefined;
  let confirmed = false;
  try {
    const result = await ctx.ui.custom<ChainClarifyResult>(
      (tui, theme, _kb, done) =>
        new ChainClarifyComponent(
          tui,
          theme,
          {
            ...preview,
            agentConfigs: preview.profiles,
            chainDir,
            resolvedBehaviors: preview.behaviors,
            availableModels: models,
            preferredProvider: ctx.model?.provider,
            availableSkills: skills,
          },
          done,
        ),
      { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
    );
    if (!result.confirmed) {
      return;
    }
    const next = applyInvocationPreview(params, result);
    const error = validateForkContextModelPolicy(next, agents, (model) =>
      resolveModelCandidate(model, models, ctx.model?.provider),
    );
    if (error !== undefined && error.length > 0) {
      throw new Error(error);
    }
    confirmed = true;
    return next;
  } finally {
    if (!confirmed && chainDir !== undefined && chainDir.length > 0) {
      removeChainDir(chainDir);
    }
  }
}
