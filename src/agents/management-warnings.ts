import type { AgentConfig, ChainStepConfig } from "../shared/types/config.ts";
import { isClaudeCodeModel } from "../runs/shared/claude-code.ts";
import { discoverAgentsAll } from "./agents.ts";
import { discoverAvailableSkills } from "./skills.ts";
import { allAgents, discoveryOptions, type ManagementContext } from "./management-targets.ts";

export function unknownChainAgents(
  ctx: ManagementContext,
  steps: readonly ChainStepConfig[],
): string[] {
  const known = new Set(
    allAgents(discoverAgentsAll(ctx.cwd, discoveryOptions(ctx))).map((agent) => agent.name),
  );
  return [
    ...new Set(
      steps
        .map((step) => step.agent)
        .filter((agent): agent is string => typeof agent === "string" && !known.has(agent)),
    ),
  ].sort((a, b) => a.localeCompare(b));
}
function modelWarning(ctx: ManagementContext, model: string | undefined): string | undefined {
  if (model === undefined || model.length === 0 || isClaudeCodeModel(model)) {
    return undefined;
  }
  const found = ctx.modelRegistry
    .getAvailable()
    .some((entry) => `${entry.provider}/${entry.id}` === model || entry.id === model);
  return found ? undefined : `Warning: model '${model}' is not in the current model registry.`;
}
function fallbackModelsWarning(
  ctx: ManagementContext,
  models: readonly string[] | undefined,
): string | undefined {
  if (models === undefined || models.length === 0) {
    return undefined;
  }
  const available = new Set(
    ctx.modelRegistry
      .getAvailable()
      .flatMap((model) => [`${model.provider}/${model.id}`, model.id]),
  );
  const missing = models.filter((model) => !isClaudeCodeModel(model) && !available.has(model));
  return missing.length > 0
    ? `Warning: fallback models not in the current model registry: ${missing.join(", ")}.`
    : undefined;
}
function skillsWarning(
  ctx: ManagementContext,
  skills: readonly string[] | undefined,
): string | undefined {
  if (skills === undefined || skills.length === 0) {
    return undefined;
  }
  const available = new Set(
    discoverAvailableSkills(ctx.cwd, discoveryOptions(ctx)).map((skill) => skill.name),
  );
  const missing = skills.filter((skill) => !available.has(skill));
  return missing.length > 0 ? `Warning: skills not found: ${missing.join(", ")}.` : undefined;
}
export function agentWarnings(
  ctx: ManagementContext,
  agent: AgentConfig,
  fields: Readonly<Record<string, unknown>>,
): string[] {
  const warnings = [
    Object.hasOwn(fields, "model") ? modelWarning(ctx, agent.model) : undefined,
    Object.hasOwn(fields, "fallbackModels")
      ? fallbackModelsWarning(ctx, agent.fallbackModels)
      : undefined,
    Object.hasOwn(fields, "skills") ? skillsWarning(ctx, agent.skills) : undefined,
  ];
  return warnings.filter(
    (warning): warning is string => warning !== undefined && warning.length > 0,
  );
}
export function chainStepWarnings(
  ctx: ManagementContext,
  steps: readonly ChainStepConfig[],
): string[] {
  const warnings: string[] = [];
  const available = new Set(
    discoverAvailableSkills(ctx.cwd, discoveryOptions(ctx)).map((skill) => skill.name),
  );
  for (const [index, step] of steps.entries()) {
    if (modelWarning(ctx, step.model) !== undefined) {
      warnings.push(
        `Warning: step ${index + 1} (${step.agent ?? "undefined"}): model '${step.model ?? "undefined"}' is not in the current model registry.`,
      );
    }
    if (step.skills !== undefined && step.skills !== false && step.skills.length > 0) {
      const missing = step.skills.filter((skill) => !available.has(skill));
      if (missing.length > 0) {
        warnings.push(
          `Warning: step ${index + 1} (${step.agent ?? "undefined"}): skills not found: ${missing.join(", ")}.`,
        );
      }
    }
  }
  return warnings;
}
export function chainWarnings(ctx: ManagementContext, steps: readonly ChainStepConfig[]): string[] {
  const missing = unknownChainAgents(ctx, steps);
  return [
    ...(missing.length > 0
      ? [`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`]
      : []),
    ...chainStepWarnings(ctx, steps),
  ];
}
export function referencingChains(ctx: ManagementContext, name: string): string[] {
  return discoverAgentsAll(ctx.cwd, discoveryOptions(ctx))
    .chains.filter((chain) => chain.steps.some((step) => step.agent === name))
    .map((chain) => `${chain.name} (${chain.source})`);
}
