import type { Writable } from "type-fest";
import type { AgentConfig } from "../shared/types/config.ts";
import {
  isConfigObject,
  readSettingsFileStrict,
  splitToolList,
  type ConfigObject,
} from "./config-values.ts";

interface BuiltinAgentOverrideConfig {
  readonly model?: string | false;
  readonly fallbackModels?: readonly string[] | false;
  readonly thinking?: string | false;
  readonly systemPromptMode?: "append" | "replace";
  readonly inheritProjectContext?: boolean;
  readonly inheritSkills?: boolean;
  readonly defaultContext?: "fresh" | "fork" | false;
  readonly disabled?: boolean;
  readonly systemPrompt?: string;
  readonly skills?: readonly string[] | false;
  readonly tools?: readonly string[] | false;
  readonly allowSubagents?: boolean;
  readonly maxExecutionTimeMs?: number | false;
  readonly maxTokens?: number | false;
  readonly completionGuard?: boolean;
}

interface SubagentSettings {
  readonly overrides: Readonly<Partial<Record<string, BuiltinAgentOverrideConfig>>>;
  readonly disableBuiltins?: boolean;
}

export const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };

type OverrideMeta = { readonly name: string; readonly filePath: string };

function invalidField(meta: OverrideMeta, field: string, expected: string): never {
  throw new Error(
    `Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${field}'; expected ${expected}.`,
  );
}

function stringOrFalse(
  input: ConfigObject,
  field: string,
  meta: OverrideMeta,
): string | false | undefined {
  if (!(field in input)) {
    return undefined;
  }
  const value = input[field];
  if (typeof value === "string" || value === false) {
    return value;
  }
  return invalidField(meta, field, "a string or false");
}

function booleanField(input: ConfigObject, field: string, meta: OverrideMeta): boolean | undefined {
  if (!(field in input)) {
    return undefined;
  }
  const value = input[field];
  return typeof value === "boolean" ? value : invalidField(meta, field, "a boolean");
}

function limitField(
  input: ConfigObject,
  field: string,
  meta: OverrideMeta,
): number | false | undefined {
  if (!(field in input)) {
    return undefined;
  }
  const value = input[field];
  if (value === false || (typeof value === "number" && Number.isInteger(value) && value >= 1)) {
    return value;
  }
  return invalidField(meta, field, "an integer >= 1 or false");
}

function arrayField(
  input: ConfigObject,
  field: string,
  meta: OverrideMeta,
): string[] | false | undefined {
  const value = input[field];
  if (value === undefined || value === false) {
    return value;
  }
  if (!Array.isArray(value)) {
    return invalidField(meta, field, "an array of strings or false");
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return invalidField(meta, field, "an array of strings or false");
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      items.push(trimmed);
    }
  }
  return items;
}

function promptMode(input: ConfigObject, meta: OverrideMeta): "append" | "replace" | undefined {
  if (!("systemPromptMode" in input)) {
    return undefined;
  }
  const value = input.systemPromptMode;
  return value === "append" || value === "replace"
    ? value
    : invalidField(meta, "systemPromptMode", "'append' or 'replace'");
}

function defaultContext(
  input: ConfigObject,
  meta: OverrideMeta,
): "fresh" | "fork" | false | undefined {
  if (!("defaultContext" in input)) {
    return undefined;
  }
  const value = input.defaultContext;
  if (value === "fresh" || value === "fork" || value === false) {
    return value;
  }
  return invalidField(meta, "defaultContext", "'fresh', 'fork', or false");
}

function systemPrompt(input: ConfigObject, meta: OverrideMeta): string | undefined {
  if (!("systemPrompt" in input)) {
    return undefined;
  }
  const value = input.systemPrompt;
  return typeof value === "string" ? value : invalidField(meta, "systemPrompt", "a string");
}

function parseOverride(
  name: string,
  value: unknown,
  filePath: string,
): BuiltinAgentOverrideConfig | undefined {
  if (!isConfigObject(value)) {
    throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
  }
  const meta = { name, filePath };
  const override: BuiltinAgentOverrideConfig = {
    model: stringOrFalse(value, "model", meta),
    thinking: stringOrFalse(value, "thinking", meta),
    systemPromptMode: promptMode(value, meta),
    inheritProjectContext: booleanField(value, "inheritProjectContext", meta),
    inheritSkills: booleanField(value, "inheritSkills", meta),
    defaultContext: defaultContext(value, meta),
    disabled: booleanField(value, "disabled", meta),
    allowSubagents: booleanField(value, "allowSubagents", meta),
    maxExecutionTimeMs: limitField(value, "maxExecutionTimeMs", meta),
    maxTokens: limitField(value, "maxTokens", meta),
    completionGuard: booleanField(value, "completionGuard", meta),
    systemPrompt: systemPrompt(value, meta),
    fallbackModels: arrayField(value, "fallbackModels", meta),
    skills: arrayField(value, "skills", meta),
    tools: arrayField(value, "tools", meta),
  };
  return Object.values(override).some((entry) => entry !== undefined) ? override : undefined;
}

export function readSubagentSettings(filePath: string | null): SubagentSettings {
  if (filePath === null) {
    return EMPTY_SUBAGENT_SETTINGS;
  }
  const subagents = readSettingsFileStrict(filePath).subagents;
  if (!isConfigObject(subagents)) {
    return EMPTY_SUBAGENT_SETTINGS;
  }
  if ("disableBuiltins" in subagents && typeof subagents.disableBuiltins !== "boolean") {
    throw new Error(
      `Subagent settings in '${filePath}' have invalid 'disableBuiltins'; expected a boolean.`,
    );
  }
  const disableBuiltins =
    typeof subagents.disableBuiltins === "boolean" ? subagents.disableBuiltins : undefined;
  const overrides: Record<string, BuiltinAgentOverrideConfig> = {};
  if (isConfigObject(subagents.agentOverrides)) {
    for (const [name, value] of Object.entries(subagents.agentOverrides)) {
      const override = parseOverride(name, value, filePath);
      if (override !== undefined) {
        overrides[name] = override;
      }
    }
  }
  return { overrides, disableBuiltins };
}

function cleared<T>(value: T | false): T | undefined {
  return value === false ? undefined : value;
}

function modelOverrides(override: BuiltinAgentOverrideConfig): Partial<Writable<AgentConfig>> {
  const patch: Partial<Writable<AgentConfig>> = {};
  if (override.model !== undefined) {
    patch.model = cleared(override.model);
  }
  if (override.fallbackModels !== undefined) {
    patch.fallbackModels =
      override.fallbackModels === false ? undefined : [...override.fallbackModels];
  }
  if (override.thinking !== undefined) {
    patch.thinking = cleared(override.thinking);
  }
  return patch;
}

function promptOverrides(override: BuiltinAgentOverrideConfig): Partial<Writable<AgentConfig>> {
  const patch: Partial<Writable<AgentConfig>> = {};
  if (override.systemPromptMode !== undefined) {
    patch.systemPromptMode = override.systemPromptMode;
  }
  if (override.inheritProjectContext !== undefined) {
    patch.inheritProjectContext = override.inheritProjectContext;
  }
  if (override.inheritSkills !== undefined) {
    patch.inheritSkills = override.inheritSkills;
  }
  if (override.defaultContext !== undefined) {
    patch.defaultContext = cleared(override.defaultContext);
  }
  if (override.systemPrompt !== undefined) {
    patch.systemPrompt = override.systemPrompt;
  }
  return patch;
}

function resourceOverrides(override: BuiltinAgentOverrideConfig): Partial<Writable<AgentConfig>> {
  const patch: Partial<Writable<AgentConfig>> = {};
  if (override.disabled !== undefined) {
    patch.disabled = override.disabled;
  }
  if (override.skills !== undefined) {
    patch.skills = override.skills === false ? undefined : [...override.skills];
  }
  if (override.tools !== undefined) {
    const { tools, mcpDirectTools } = splitToolList(override.tools === false ? [] : override.tools);
    patch.tools = tools;
    patch.mcpDirectTools = mcpDirectTools;
  }
  if (override.allowSubagents !== undefined) {
    patch.allowSubagents = override.allowSubagents;
  }
  if (override.maxExecutionTimeMs !== undefined) {
    patch.maxExecutionTimeMs = cleared(override.maxExecutionTimeMs);
  }
  if (override.maxTokens !== undefined) {
    patch.maxTokens = cleared(override.maxTokens);
  }
  if (override.completionGuard !== undefined) {
    patch.completionGuard = override.completionGuard;
  }
  return patch;
}

function applyBuiltinOverride(
  agent: AgentConfig,
  override: BuiltinAgentOverrideConfig,
): AgentConfig {
  return {
    ...agent,
    ...modelOverrides(override),
    ...promptOverrides(override),
    ...resourceOverrides(override),
  };
}

export function applyBuiltinOverrides(
  builtinAgents: readonly AgentConfig[],
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  projectSettingsPath: string | null,
): AgentConfig[] {
  return builtinAgents.map((agent) => {
    const userOverride = userSettings.overrides[agent.name];
    let next = agent;
    if (userOverride !== undefined) {
      next = applyBuiltinOverride(agent, userOverride);
    } else if (userSettings.disableBuiltins === true) {
      next = { ...agent, disabled: true };
    }
    if (projectSettingsPath !== null) {
      const projectOverride = projectSettings.overrides[agent.name];
      if (projectOverride !== undefined) {
        next = applyBuiltinOverride({ ...next, disabled: false }, projectOverride);
      } else if (projectSettings.disableBuiltins !== undefined) {
        next = { ...next, disabled: projectSettings.disableBuiltins };
      }
    }
    return next;
  });
}
