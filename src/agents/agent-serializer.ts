import type { AgentConfig } from "../shared/types/config.ts";
import { frontmatterNameForConfig } from "./identity.ts";

export const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "package",
  "description",
  "tools",
  "allowSubagents",
  "model",
  "fallbackModels",
  "thinking",
  "systemPromptMode",
  "inheritProjectContext",
  "inheritSkills",
  "defaultContext",
  "skill",
  "skills",
  "extensions",
  "output",
  "defaultReads",
  "defaultProgress",
  "interactive",
  "maxSubagentDepth",
  "maxExecutionTimeMs",
  "maxTokens",
  "completionGuard",
]);
function stringLine(field: string, value: string | undefined): string[] {
  return value !== undefined && value.length > 0 ? [`${field}: ${value}`] : [];
}
function listLine(field: string, values: readonly string[] | undefined): string[] {
  return values !== undefined && values.length > 0 ? [`${field}: ${values.join(", ")}`] : [];
}
function limitLine(field: string, value: number | undefined, minimum: number): string[] {
  return value !== undefined && Number.isInteger(value) && value >= minimum
    ? [`${field}: ${value}`]
    : [];
}
function identityLines(config: AgentConfig): string[] {
  return [
    `name: ${frontmatterNameForConfig(config)}`,
    ...stringLine("package", config.packageName),
    `description: ${config.description}`,
  ];
}
function modelAndContextLines(config: AgentConfig): string[] {
  return [
    ...stringLine("model", config.model),
    ...listLine("fallbackModels", config.fallbackModels),
    ...stringLine("thinking", config.thinking === "off" ? undefined : config.thinking),
    `systemPromptMode: ${config.systemPromptMode}`,
    `inheritProjectContext: ${config.inheritProjectContext ? "true" : "false"}`,
    `inheritSkills: ${config.inheritSkills ? "true" : "false"}`,
    ...stringLine("defaultContext", config.defaultContext),
  ];
}
function resourceLines(config: AgentConfig): string[] {
  return [
    ...listLine("skills", config.skills),
    ...(config.extensions === undefined ? [] : [`extensions: ${config.extensions.join(", ")}`]),
    ...stringLine("output", config.output),
    ...listLine("defaultReads", config.defaultReads),
    ...(config.defaultProgress === true ? ["defaultProgress: true"] : []),
    ...(config.interactive === true ? ["interactive: true"] : []),
    ...limitLine("maxSubagentDepth", config.maxSubagentDepth, 0),
    ...limitLine("maxExecutionTimeMs", config.maxExecutionTimeMs, 1),
    ...limitLine("maxTokens", config.maxTokens, 1),
    ...(config.completionGuard === undefined ? [] : [`completionGuard: ${config.completionGuard}`]),
  ];
}
export function serializeAgent(config: AgentConfig): string {
  const tools = [
    ...(config.tools ?? []),
    ...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
  ];
  const lines = [
    "---",
    ...identityLines(config),
    ...listLine("tools", tools),
    ...(config.allowSubagents === true ? ["allowSubagents: true"] : []),
    ...modelAndContextLines(config),
    ...resourceLines(config),
    ...Object.entries(config.extraFields ?? {})
      .filter(([key]) => !KNOWN_FIELDS.has(key))
      .map(([key, value]) => `${key}: ${value}`),
    "---",
  ];
  return `${lines.join("\n")}\n\n${config.systemPrompt}\n`;
}
