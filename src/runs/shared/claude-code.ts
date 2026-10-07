import { randomUUID } from "node:crypto";
import type { JsonSchemaObject, ObservedMessage, ObservedUsage } from "../../shared/types.ts";
import { parseClaudeCodeModel, type ClaudeCodeModelSpec } from "./claude-model.ts";
export {
  isClaudeCodeModel,
  parseClaudeCodeModel,
  type ClaudeCodeModelSpec,
} from "./claude-model.ts";
import { readClaudeCodeSessionMetadata, hasNonMetadataContent } from "./claude-session.ts";
export {
  readClaudeCodeSessionMetadata,
  writeClaudeCodeSessionMetadata,
  appendClaudeCodeMessage,
  type ClaudeCodeSessionMetadata,
} from "./claude-session.ts";
import type { ClaudeCodeInvocation, ClaudeCodeResultEvent } from "./claude-types.ts";
export type { ClaudeCodeInvocation, ClaudeCodeResultEvent } from "./claude-types.ts";
import { nonempty } from "./child-presence.ts";

interface ClaudeInvocationInput {
  readonly model: string;
  readonly task: string;
  readonly systemPrompt?: string;
  readonly systemPromptMode?: "append" | "replace";
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly tools?: readonly string[];
  readonly mcpDirectTools?: readonly string[];
  readonly allowSubagents?: boolean;
  readonly inheritProjectContext?: boolean;
  readonly inheritSkills?: boolean;
  readonly outputSchema?: JsonSchemaObject;
}
function sessionArgs(
  input: ClaudeInvocationInput,
  parsed: ClaudeCodeModelSpec,
  sessionId: string,
  resuming: boolean,
): string[] {
  const args = [
    "-p",
    "--dangerously-skip-permissions",
    "--model",
    parsed.cliModel,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (nonempty(parsed.thinking) && parsed.thinking !== "minimal") {
    args.push("--effort", parsed.thinking);
  }
  if (nonempty(input.sessionName)) {
    args.push("--name", input.sessionName);
  }
  args.push(resuming ? "--resume" : "--session-id", sessionId);
  return args;
}
function contextArgs(input: ClaudeInvocationInput): string[] {
  if (input.allowSubagents === true) {
    throw new Error(
      "Claude Code backend does not support nested subagent fanout. Use a Pi-backed model for allowSubagents.",
    );
  }
  const inheritContext = input.inheritProjectContext ?? true;
  const inheritSkills = input.inheritSkills ?? true;
  if (!inheritContext && inheritSkills) {
    throw new Error(
      "Claude Code cannot disable project setting sources while preserving their skills. Set inheritSkills: false or use a Pi-backed model.",
    );
  }
  return [
    ...(inheritContext ? [] : ["--setting-sources", ""]),
    ...(inheritSkills ? [] : ["--disable-slash-commands"]),
    "--disallowedTools=Agent",
  ];
}
function promptArgs(input: ClaudeInvocationInput): string[] {
  const args: string[] = [];
  if (input.systemPrompt !== undefined && input.systemPrompt.trim().length > 0) {
    args.push(
      input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      input.systemPrompt,
    );
  }
  args.push(...contextArgs(input));
  const mappedTools = mapClaudeCodeTools(input.tools, input.mcpDirectTools);
  if (input.outputSchema) {
    args.push("--json-schema", JSON.stringify(input.outputSchema));
  }
  args.push(input.task);
  if (mappedTools !== undefined) {
    args.push("--tools", mappedTools);
  }
  return args;
}
export function buildClaudeCodeInvocation(input: ClaudeInvocationInput): ClaudeCodeInvocation {
  const parsed = parseClaudeCodeModel(input.model);
  const existing = readClaudeCodeSessionMetadata(input.sessionFile);
  if (nonempty(input.sessionFile) && !existing && hasNonMetadataContent(input.sessionFile)) {
    throw new Error(
      `Claude Code backend cannot resume non-Claude session file: ${input.sessionFile}. Use fresh context for claude-code/* subagents.`,
    );
  }
  const sessionId = existing?.sessionId ?? randomUUID();
  return {
    command: "claude",
    args: [...sessionArgs(input, parsed, sessionId, existing !== undefined), ...promptArgs(input)],
    env: nonempty(parsed.autoCompactWindow)
      ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: parsed.autoCompactWindow }
      : {},
    sessionId,
    resuming: existing !== undefined,
    model: parsed,
  };
}

const TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  glob: "Glob",
  web_fetch: "WebFetch",
  webfetch: "WebFetch",
  web_search: "WebSearch",
  websearch: "WebSearch",
};
function mappedToolNames(tools: readonly string[]): { mapped: string[]; unsupported: string[] } {
  const mapped: string[] = [];
  const unsupported: string[] = [];
  for (const tool of tools) {
    const name = tool.trim();
    if (name.length === 0) {
      continue;
    }
    const mappedTool = TOOL_NAMES[name.toLowerCase()];
    if (typeof mappedTool === "string" && mappedTool.length > 0) {
      mapped.push(mappedTool);
    } else {
      unsupported.push(name);
    }
  }
  return { mapped, unsupported };
}
function mapClaudeCodeTools(
  tools: readonly string[] | undefined,
  mcpDirectTools: readonly string[] | undefined,
): string | undefined {
  if (mcpDirectTools !== undefined && mcpDirectTools.length > 0) {
    throw new Error(
      `Claude Code backend does not support MCP direct tool allowlist entries: ${mcpDirectTools.join(", ")}. Use a Pi-backed model for MCP direct tools.`,
    );
  }
  if (!tools || tools.length === 0) {
    return;
  }
  const { mapped, unsupported } = mappedToolNames(tools);
  if (unsupported.length > 0 || mapped.length === 0) {
    throw new Error(
      `Claude Code backend does not support tool allowlist entr${unsupported.length === 1 ? "y" : "ies"}: ${(unsupported.length > 0 ? unsupported : tools).join(", ")}. Supported tools: bash, read, edit, write, grep, glob, web_fetch, web_search.`,
    );
  }
  return [...new Set(mapped)].join(",");
}

function observedClaudeUsage(event: ClaudeCodeResultEvent): ObservedUsage | undefined {
  const counters = {
    input: event.usage?.input_tokens,
    output: event.usage?.output_tokens,
    cacheRead: event.usage?.cache_read_input_tokens,
    cacheWrite: event.usage?.cache_creation_input_tokens,
  };
  const values = Object.values(counters);
  if (values.every((value) => value === undefined) && event.total_cost_usd === undefined) {
    return;
  }
  const observed = Object.fromEntries(
    Object.entries(counters).filter(([, value]) => value !== undefined),
  );
  return {
    ...observed,
    ...(values.every((value) => typeof value === "number")
      ? { totalTokens: values.reduce<number>((sum, value) => sum + value, 0) }
      : {}),
    ...(event.total_cost_usd !== undefined ? { cost: { total: event.total_cost_usd } } : {}),
  };
}
function resultFailure(event: ClaudeCodeResultEvent): string | undefined {
  const status = event.api_error_status;
  const hasStatus = status !== undefined && status !== null && status !== 0;
  if (event.is_error !== true && event.subtype !== "error" && !hasStatus) {
    return;
  }
  return nonempty(event.result)
    ? event.result
    : `Claude Code failed${hasStatus ? ` (${status})` : ""}.`;
}
export function claudeCodeMessageFromResult(
  event: ClaudeCodeResultEvent,
  fallbackModel: string,
): ObservedMessage {
  const errorMessage = resultFailure(event);
  return {
    role: "assistant",
    content: [{ type: "text", text: event.result ?? "" }],
    model: resolveClaudeCodeResultModel(event) ?? fallbackModel,
    stopReason: errorMessage !== undefined ? "error" : "stop",
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    usage: observedClaudeUsage(event),
  };
}
export function resolveClaudeCodeResultModel(event: ClaudeCodeResultEvent): string | undefined {
  const keys = Object.keys(event.modelUsage ?? {});
  return keys.find((key) => !key.includes("haiku")) ?? keys.at(0);
}
