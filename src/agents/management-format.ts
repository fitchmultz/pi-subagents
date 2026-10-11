import type { AgentConfig, ChainConfig, ChainStepConfig } from "../shared/types/config.ts";
import { resolveEffectiveThinking } from "../shared/model-info.ts";
import { frontmatterNameForConfig } from "./identity.ts";
import { isConfigObject } from "./config-values.ts";

export function formatModelDefaults(agent: AgentConfig): string[] {
  const thinking = resolveEffectiveThinking(agent.model, agent.thinking) ?? agent.thinking;
  const inherited = "inherited runtime default (unset)";
  const fallbacks = agent.fallbackModels?.map(
    (model) =>
      `${model} (thinking: ${resolveEffectiveThinking(model, agent.thinking ?? thinking) ?? inherited})`,
  );
  return [
    `Model: ${agent.model ?? "inherited from parent (resolved at launch)"}`,
    `Thinking: ${thinking ?? inherited}`,
    `Fallback models: ${fallbacks !== undefined && fallbacks.length > 0 ? fallbacks.join(", ") : "none configured"}`,
  ];
}
function optionalLine(label: string, value: string | undefined): string[] {
  return value !== undefined && value.length > 0 ? [`${label}: ${value}`] : [];
}
function listLine(label: string, value: readonly string[] | undefined): string[] {
  return value !== undefined && value.length > 0 ? [`${label}: ${value.join(", ")}`] : [];
}
function packageLines(config: AgentConfig | ChainConfig): string[] {
  return config.packageName !== undefined && config.packageName.length > 0
    ? [`Local name: ${frontmatterNameForConfig(config)}`, `Package: ${config.packageName}`]
    : [];
}
function executionLines(agent: AgentConfig): string[] {
  return [
    ...optionalLine("Output", agent.output),
    ...listLine("Reads", agent.defaultReads),
    ...(agent.defaultProgress === true ? ["Progress: true"] : []),
    ...(agent.allowSubagents === true ? ["Allow subagents: true"] : []),
    ...(agent.maxSubagentDepth === undefined
      ? []
      : [`Max subagent depth: ${agent.maxSubagentDepth}`]),
    ...(agent.maxExecutionTimeMs === undefined
      ? []
      : [`Max execution time: ${agent.maxExecutionTimeMs}ms`]),
    ...(agent.maxTokens === undefined ? [] : [`Max tokens: ${agent.maxTokens}`]),
    ...(agent.completionGuard === undefined ? [] : [`Completion guard: ${agent.completionGuard}`]),
  ];
}
export function formatAgentDetail(agent: AgentConfig): string {
  const tools = [
    ...(agent.tools ?? []),
    ...(agent.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
  ];
  const lines = [
    `Agent: ${agent.name} (${agent.source})`,
    `Path: ${agent.filePath}`,
    `Description: ${agent.description}`,
    ...packageLines(agent),
    ...formatModelDefaults(agent),
    ...listLine("Tools", tools),
    ...listLine("Skills", agent.skills),
    `System prompt mode: ${agent.systemPromptMode}`,
    `Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`,
    `Inherit skills: ${agent.inheritSkills ? "true" : "false"}`,
    ...optionalLine("Default context", agent.defaultContext),
    ...(agent.source === "builtin"
      ? [`Disabled: ${agent.disabled === true ? "true" : "false"}`]
      : []),
    ...(agent.extensions === undefined
      ? []
      : [`Extensions: ${agent.extensions.length > 0 ? agent.extensions.join(", ") : "(none)"}`]),
    ...executionLines(agent),
  ];
  if (agent.systemPrompt.trim().length > 0) {
    lines.push("", "System Prompt:", agent.systemPrompt);
  }
  return lines.join("\n");
}
function hasDisplayValue(value: unknown): boolean {
  return Boolean(value);
}

function displayUnknown(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item: unknown) => (item === null || item === undefined ? "" : displayUnknown(item)))
      .join(",");
  }
  return Object.prototype.toString.call(value);
}
function dynamicExpansionLines(value: unknown): string[] {
  if (!isConfigObject(value)) {
    return [];
  }
  const lines: string[] = [];
  if (isConfigObject(value.from)) {
    lines.push(
      `   Expand: ${displayUnknown(value.from.output ?? "?")}${displayUnknown(value.from.path ?? "")}`,
    );
  }
  if (typeof value.item === "string") {
    lines.push(`   Item variable: ${value.item}`);
  }
  if (typeof value.key === "string") {
    lines.push(`   Key: ${value.key}`);
  }
  if (typeof value.maxItems === "number") {
    lines.push(`   Max items: ${value.maxItems}`);
  }
  if (typeof value.onEmpty === "string") {
    lines.push(`   On empty: ${value.onEmpty}`);
  }
  return lines;
}
function dynamicTemplateLines(value: unknown): string[] {
  if (!isConfigObject(value)) {
    return [];
  }
  const lines: string[] = [];
  if (hasDisplayValue(value.agent)) {
    lines.push(`   Agent: ${displayUnknown(value.agent)}`);
  }
  if (typeof value.label === "string") {
    lines.push(`   Label: ${value.label}`);
  }
  if (typeof value.task === "string" && value.task.trim().length > 0) {
    lines.push(`   Task: ${value.task}`);
  }
  if (hasDisplayValue(value.outputSchema)) {
    lines.push("   Structured output: true");
  }
  return lines;
}
function formatDynamicStep(step: ChainStepConfig, index: number): string[] {
  const collect = isConfigObject(step.collect) ? step.collect : undefined;
  return [
    `${index + 1}. Dynamic fanout${typeof collect?.as === "string" ? ` -> ${collect.as}` : ""}`,
    ...dynamicExpansionLines(step.expand),
    ...dynamicTemplateLines(step.parallel),
    ...(hasDisplayValue(collect?.outputSchema) ? ["   Collect schema: true"] : []),
    ...(step.concurrency === undefined ? [] : [`   Concurrency: ${step.concurrency}`]),
    ...(step.failFast === undefined ? [] : [`   Fail fast: ${step.failFast ? "true" : "false"}`]),
  ];
}
function stepListLine(label: string, value: readonly string[] | false | undefined): string[] {
  return value === false ? [`   ${label}: false`] : listLine(`   ${label}`, value);
}
function formatChainStepDetail(step: ChainStepConfig, index: number): string[] {
  if (step.expand !== undefined || step.collect !== undefined) {
    return formatDynamicStep(step, index);
  }
  const lines = [
    `${index + 1}. ${step.agent ?? "undefined"}`,
    ...optionalLine("   Task", step.task?.trim().length === 0 ? undefined : step.task),
    ...(step.output === false ? ["   Output: false"] : optionalLine("   Output", step.output)),
    ...optionalLine("   Output mode", step.outputMode),
    ...stepListLine("Reads", step.reads),
    ...optionalLine("   Model", step.model),
    ...stepListLine("Skills", step.skills),
    ...(step.progress === undefined ? [] : [`   Progress: ${step.progress ? "true" : "false"}`]),
  ];
  return lines;
}
export function formatChainDetail(chain: ChainConfig): string {
  return [
    `Chain: ${chain.name} (${chain.source})`,
    `Path: ${chain.filePath}`,
    `Description: ${chain.description}`,
    ...packageLines(chain),
    "",
    "Steps:",
    ...chain.steps.flatMap((step, index) => formatChainStepDetail(step, index)),
  ].join("\n");
}

const AGENT_ROLE_HINTS = {
  Recon: "Use for read-only codebase mapping, grep/delta sweeps, and external facts.",
  Planning: "Use when decomposition or an implementation handoff matters.",
  Implementation: "Use for bounded code/doc changes after scope is clear.",
  Review: "Use for independent validation, regressions, and drift checks.",
  Coordination: "Use for generic delegation or high-context decision checks.",
  Specialized: "Use only when the task matches the skill description.",
  "Custom/other": "Project/user agents not classified by the builtins.",
};
type AgentListRole = keyof typeof AGENT_ROLE_HINTS;
function agentListRole(agent: AgentConfig): AgentListRole {
  const name = agent.name.split(".").at(-1) ?? agent.name;
  if (["scout", "context-builder", "researcher"].includes(name)) {
    return "Recon";
  }
  if (name === "planner") {
    return "Planning";
  }
  if (["worker", "fixer"].includes(name)) {
    return "Implementation";
  }
  if (name === "reviewer" || name.includes("review")) {
    return "Review";
  }
  if (["delegate", "oracle"].includes(name)) {
    return "Coordination";
  }
  return agent.source === "builtin" ? "Specialized" : "Custom/other";
}
function formatAgentListLine(agent: AgentConfig): string {
  return `- ${agent.name} (${agent.source}${agent.defaultContext === undefined ? "" : `, context: ${agent.defaultContext}`}): ${agent.description}\n  ${formatModelDefaults(agent).join("; ")}`;
}
export function formatAgentGroups(agents: readonly AgentConfig[]): string[] {
  const lines = ["Executable agents (grouped by role):"];
  if (agents.length === 0) {
    return [...lines, "- (none)"];
  }
  const roles: AgentListRole[] = [
    "Recon",
    "Planning",
    "Implementation",
    "Review",
    "Coordination",
    "Specialized",
    "Custom/other",
  ];
  for (const role of roles) {
    const group = agents.filter((agent) => agentListRole(agent) === role);
    if (group.length > 0) {
      lines.push("", `**${role}** — ${AGENT_ROLE_HINTS[role]}`, ...group.map(formatAgentListLine));
    }
  }
  return lines;
}
