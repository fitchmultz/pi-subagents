import type { Writable } from "type-fest";
import type { AgentConfig, ChainStepConfig } from "../shared/types/config.ts";
import { csvItems, isConfigObject, errorMessage, type ConfigObject } from "./config-values.ts";

export type ConfigParse<T> =
  | { readonly value: T; readonly error?: never }
  | { readonly error: string; readonly value?: never };
class ConfigValidationError extends Error {}
type AgentPatch = Partial<Writable<AgentConfig>>;

export function configObject(config: unknown): { value?: ConfigObject; error?: string } {
  let value = config;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return { error: `config must be valid JSON: ${errorMessage(error)}` };
    }
  }
  return isConfigObject(value) ? { value } : {};
}

export function hasKey(object: ConfigObject, key: string): boolean {
  return Object.hasOwn(object, key);
}
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function parseCsv(value: string): string[] {
  return [...new Set(csvItems(value))];
}
function invalid(field: string, expected: string): never {
  throw new ConfigValidationError(`config.${field} must be ${expected} when provided.`);
}

function stringField(value: unknown, field: string, trim = false): string | undefined {
  if (value === false || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return invalid(field, "a string or false");
  }
  const parsed = trim ? value.trim() : value;
  return parsed.length === 0 ? undefined : parsed;
}
function csvField(value: unknown, field: string): string[] | undefined {
  if (value === false || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return invalid(field, "a comma-separated string or false");
  }
  const parsed = parseCsv(value);
  return parsed.length > 0 ? parsed : undefined;
}
function booleanField(value: unknown, field: string): boolean {
  return typeof value === "boolean" ? value : invalid(field, "a boolean");
}
function limitField(value: unknown, field: string, minimum: number): number | undefined {
  if (value === false || value === "") {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= minimum) {
    return value;
  }
  return invalid(field, `an integer >= ${minimum} or false`);
}
function fallbackModels(value: unknown): string[] | undefined {
  if (value === false || value === "") {
    return undefined;
  }
  let models: string[];
  if (typeof value === "string") {
    models = parseCsv(value);
  } else if (Array.isArray(value)) {
    models = [
      ...new Set(
        value
          .filter((item: unknown): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    ];
  } else {
    return invalid("fallbackModels", "a comma-separated string, string array, or false");
  }
  return models.length > 0 ? models : undefined;
}
function tools(value: unknown): Pick<AgentConfig, "tools" | "mcpDirectTools"> {
  const parsed = csvField(value, "tools") ?? [];
  const direct = parsed
    .filter((item) => item.startsWith("mcp:"))
    .map((item) => item.slice(4).trim())
    .filter((item) => item.length > 0);
  const native = parsed.filter((item) => !item.startsWith("mcp:"));
  return {
    tools: native.length > 0 ? native : undefined,
    mcpDirectTools: direct.length > 0 ? direct : undefined,
  };
}
function extensions(value: unknown): readonly string[] | undefined {
  if (value === false) {
    return undefined;
  }
  if (typeof value === "string") {
    return parseCsv(value);
  }
  return invalid("extensions", "a comma-separated string, empty string, or false");
}
function promptMode(value: unknown): "append" | "replace" {
  return value === "append" || value === "replace"
    ? value
    : invalid("systemPromptMode", "'append' or 'replace'");
}
function defaultContext(value: unknown): "fresh" | "fork" | undefined {
  if (value === false || value === "") {
    return undefined;
  }
  return value === "fresh" || value === "fork"
    ? value
    : invalid("defaultContext", "'fresh', 'fork', or false");
}

function promptPatch(cfg: ConfigObject): AgentPatch {
  const patch: AgentPatch = {};
  if (hasKey(cfg, "systemPrompt")) {
    patch.systemPrompt = stringField(cfg.systemPrompt, "systemPrompt") ?? "";
  }
  if (hasKey(cfg, "systemPromptMode")) {
    patch.systemPromptMode = promptMode(cfg.systemPromptMode);
  }
  if (hasKey(cfg, "inheritProjectContext")) {
    patch.inheritProjectContext = booleanField(cfg.inheritProjectContext, "inheritProjectContext");
  }
  if (hasKey(cfg, "inheritSkills")) {
    patch.inheritSkills = booleanField(cfg.inheritSkills, "inheritSkills");
  }
  if (hasKey(cfg, "defaultContext")) {
    patch.defaultContext = defaultContext(cfg.defaultContext);
  }
  return patch;
}
function modelPatch(cfg: ConfigObject): AgentPatch {
  const patch: AgentPatch = {};
  if (hasKey(cfg, "model")) {
    patch.model = stringField(cfg.model, "model", true);
  }
  if (hasKey(cfg, "fallbackModels")) {
    patch.fallbackModels = fallbackModels(cfg.fallbackModels);
  }
  if (hasKey(cfg, "thinking")) {
    patch.thinking = stringField(cfg.thinking, "thinking", true);
  }
  return patch;
}
function resourcePatch(cfg: ConfigObject): AgentPatch {
  const patch: AgentPatch = {};
  if (hasKey(cfg, "tools")) {
    Object.assign(patch, tools(cfg.tools));
  }
  if (hasKey(cfg, "skills")) {
    patch.skills = csvField(cfg.skills, "skills");
  }
  if (hasKey(cfg, "extensions")) {
    patch.extensions = extensions(cfg.extensions);
  }
  if (hasKey(cfg, "output")) {
    patch.output = stringField(cfg.output, "output");
  }
  if (hasKey(cfg, "reads")) {
    patch.defaultReads = csvField(cfg.reads, "reads");
  }
  if (hasKey(cfg, "progress")) {
    patch.defaultProgress = booleanField(cfg.progress, "progress");
  }
  return patch;
}
function executionPatch(cfg: ConfigObject): AgentPatch {
  const patch: AgentPatch = {};
  if (hasKey(cfg, "allowSubagents")) {
    patch.allowSubagents = booleanField(cfg.allowSubagents, "allowSubagents");
  }
  if (hasKey(cfg, "maxSubagentDepth")) {
    patch.maxSubagentDepth = limitField(cfg.maxSubagentDepth, "maxSubagentDepth", 0);
  }
  if (hasKey(cfg, "maxExecutionTimeMs")) {
    patch.maxExecutionTimeMs = limitField(cfg.maxExecutionTimeMs, "maxExecutionTimeMs", 1);
  }
  if (hasKey(cfg, "maxTokens")) {
    patch.maxTokens = limitField(cfg.maxTokens, "maxTokens", 1);
  }
  if (hasKey(cfg, "completionGuard")) {
    patch.completionGuard = booleanField(cfg.completionGuard, "completionGuard");
  }
  return patch;
}
const AGENT_KEYS = new Set([
  "name",
  "package",
  "description",
  "scope",
  "systemPrompt",
  "model",
  "fallbackModels",
  "tools",
  "skills",
  "extensions",
  "thinking",
  "systemPromptMode",
  "inheritProjectContext",
  "inheritSkills",
  "defaultContext",
  "output",
  "reads",
  "progress",
  "allowSubagents",
  "maxSubagentDepth",
  "maxExecutionTimeMs",
  "maxTokens",
  "completionGuard",
]);
const CHAIN_KEYS = new Set(["name", "package", "description", "scope", "steps"]);
function unknownKeys(cfg: ConfigObject, keys: readonly string[]): string | undefined {
  const unknown = Object.keys(cfg).filter((key) => !keys.includes(key));
  return unknown.length > 0
    ? `config has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`
    : undefined;
}
export function validateChainConfigKeys(cfg: ConfigObject): string | undefined {
  return unknownKeys(cfg, [...CHAIN_KEYS]);
}
export function parseAgentPatch(cfg: ConfigObject): ConfigParse<AgentPatch> {
  const error = unknownKeys(cfg, [...AGENT_KEYS]);
  if (error !== undefined) {
    return { error };
  }
  try {
    return {
      value: {
        ...promptPatch(cfg),
        ...modelPatch(cfg),
        ...resourcePatch(cfg),
        ...executionPatch(cfg),
      },
    };
  } catch (caught) {
    if (caught instanceof ConfigValidationError) {
      return { error: caught.message };
    }
    throw caught;
  }
}

const STEP_KEYS = new Set([
  "agent",
  "task",
  "phase",
  "label",
  "as",
  "outputSchema",
  "output",
  "outputMode",
  "reads",
  "model",
  "skills",
  "progress",
]);
function stepError(index: number, field: string, expected: string): never {
  throw new ConfigValidationError(`config.steps[${index}].${field} must be ${expected}.`);
}
function stepString(step: ConfigObject, field: string, index: number): string | undefined {
  if (!hasKey(step, field)) {
    return undefined;
  }
  const value = step[field];
  return typeof value === "string" ? value : stepError(index, field, "a string");
}
function stepList(step: ConfigObject, field: string, index: number): string[] | false | undefined {
  if (!hasKey(step, field)) {
    return undefined;
  }
  const value = step[field];
  if (value === false) {
    return false;
  }
  if (Array.isArray(value) && value.every((item: unknown) => typeof item === "string")) {
    return value.map((item) => item.trim()).filter((item) => item.length > 0);
  }
  return stepError(index, field, "a string array or false");
}
function stepOutput(step: ConfigObject, index: number): string | false | undefined {
  if (!hasKey(step, "output")) {
    return undefined;
  }
  const value = step.output;
  return typeof value === "string" || value === false
    ? value
    : stepError(index, "output", "a string or false");
}
function stepOutputMode(step: ConfigObject, index: number): "inline" | "file-only" | undefined {
  if (!hasKey(step, "outputMode")) {
    return undefined;
  }
  const value = step.outputMode;
  return value === "inline" || value === "file-only"
    ? value
    : stepError(index, "outputMode", "'inline' or 'file-only'");
}
function stepProgress(step: ConfigObject, index: number): boolean | undefined {
  if (!hasKey(step, "progress")) {
    return undefined;
  }
  return typeof step.progress === "boolean"
    ? step.progress
    : stepError(index, "progress", "a boolean");
}
function stepSchema(step: ConfigObject, index: number): string | undefined {
  if (!hasKey(step, "outputSchema")) {
    return undefined;
  }
  return typeof step.outputSchema === "string"
    ? step.outputSchema
    : stepError(index, "outputSchema", "a schema file path string for saved chains");
}
function parseStep(item: unknown, index: number): ChainStepConfig {
  if (!isConfigObject(item)) {
    throw new ConfigValidationError(`config.steps[${index}] must be an object.`);
  }
  if (hasKey(item, "skill")) {
    throw new ConfigValidationError(`config.steps[${index}].skill is not supported; use skills.`);
  }
  const unknown = Object.keys(item).filter((key) => !STEP_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ConfigValidationError(
      `config.steps[${index}] has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
  if (typeof item.agent !== "string" || item.agent.trim().length === 0) {
    return stepError(index, "agent", "a non-empty string");
  }
  return {
    agent: item.agent.trim(),
    task: typeof item.task === "string" ? item.task : "",
    phase: stepString(item, "phase", index),
    label: stepString(item, "label", index),
    as: stepString(item, "as", index),
    outputSchema: stepSchema(item, index),
    output: stepOutput(item, index),
    outputMode: stepOutputMode(item, index),
    reads: stepList(item, "reads", index),
    model: stepString(item, "model", index),
    skills: stepList(item, "skills", index),
    progress: stepProgress(item, index),
  };
}
export function parseStepList(raw: unknown): ConfigParse<ChainStepConfig[]> {
  if (!Array.isArray(raw)) {
    return { error: "config.steps must be an array." };
  }
  if (raw.length === 0) {
    return { error: "config.steps must include at least one step." };
  }
  try {
    return { value: raw.map((item: unknown, index) => parseStep(item, index)) };
  } catch (caught) {
    if (caught instanceof ConfigValidationError) {
      return { error: caught.message };
    }
    throw caught;
  }
}
