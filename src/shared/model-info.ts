export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
import type { ModelInfo, ThinkingLevel, ThinkingLevelMap } from "./types/config.ts";
export type { ModelInfo, ThinkingLevel, ThinkingLevelMap } from "./types/config.ts";

interface RegistryModelLike {
  readonly provider: string;
  readonly id: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
}

export function toModelInfo(model: RegistryModelLike): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    fullId: `${model.provider}/${model.id}`,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
  };
}

export function providerQualifiedModelId(
  provider: string | undefined,
  model: string | undefined,
): string | undefined {
  if (model === undefined || model.length === 0) {
    return undefined;
  }
  return provider !== undefined && provider.length > 0 && !model.startsWith(`${provider}/`)
    ? `${provider}/${model}`
    : model;
}

/** Resolve the effective thinking level from a model string (which may contain a known suffix like `:high`)
 * and an explicit thinking config value. Returns `undefined` when no thinking is applicable
 * (e.g. no model was specified, or the model has no suffix and no config was provided). */
export function resolveEffectiveThinking(
  model: string | undefined,
  configThinking: string | undefined,
): string | undefined {
  if (model === undefined || model.length === 0) {
    return undefined;
  }
  const { thinkingSuffix } = splitKnownThinkingSuffix(model);
  if (thinkingSuffix.length > 0) {
    return thinkingSuffix.slice(1);
  }
  return THINKING_LEVELS.find((level) => level === configThinking);
}

export function splitKnownThinkingSuffix(model: string): {
  baseModel: string;
  thinkingSuffix: string;
} {
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx === -1) {
    return { baseModel: model, thinkingSuffix: "" };
  }
  const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
  if (suffix === undefined) {
    return { baseModel: model, thinkingSuffix: "" };
  }
  return {
    baseModel: model.substring(0, colonIdx),
    thinkingSuffix: `:${suffix}`,
  };
}

export function findModelInfo(
  model: string | undefined,
  availableModels: readonly ModelInfo[] | undefined,
  preferredProvider?: string,
): ModelInfo | undefined {
  if (
    model === undefined ||
    model.length === 0 ||
    availableModels === undefined ||
    availableModels.length === 0
  ) {
    return undefined;
  }
  const { baseModel } = splitKnownThinkingSuffix(model);
  const exact = availableModels.find((entry) => entry.fullId === baseModel);
  if (exact) {
    return exact;
  }

  const matches = availableModels.filter((entry) => entry.id === baseModel);
  if (preferredProvider !== undefined && preferredProvider.length > 0) {
    const preferred = matches.find((entry) => entry.provider === preferredProvider);
    if (preferred) {
      return preferred;
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function getSupportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
  if (model === undefined) {
    return [...THINKING_LEVELS];
  }
  if (model.reasoning === false) {
    return ["off"];
  }

  const levels = THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
  return levels;
}
