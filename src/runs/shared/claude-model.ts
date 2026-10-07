import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import { nonempty } from "./child-presence.ts";

const PREFIX = "claude-code/";
export type ClaudeFamily = "fable" | "opus" | "sonnet" | "haiku";
export type ClaudeContext = "300k" | "1m" | "native";
export interface ClaudeCodeModelSpec {
  readonly inputModel: string;
  readonly family: ClaudeFamily;
  readonly context: ClaudeContext;
  readonly thinking?: string;
  readonly cliModel: string;
  readonly autoCompactWindow?: string;
}

export function isClaudeCodeModel(model: string | undefined): boolean {
  return model?.startsWith(PREFIX) === true;
}

export function isClaudeFamily(family: unknown): family is ClaudeFamily {
  return family === "fable" || family === "opus" || family === "sonnet" || family === "haiku";
}

export function isClaudeContext(context: unknown): context is ClaudeContext {
  return context === "300k" || context === "1m" || context === "native";
}

function resolveContext(
  family: ClaudeFamily,
  contextRaw: string | undefined,
  model: string,
): ClaudeContext {
  const context = contextRaw ?? (family === "haiku" ? "native" : "300k");
  if (!isClaudeContext(context)) {
    throw new Error(
      `Unsupported Claude Code context '${context}' in '${model}'. Use @300k or @1m.`,
    );
  }
  if (family === "haiku" && context !== "native") {
    throw new Error(`Claude Code haiku does not support @${context} context.`);
  }
  return context;
}

export function parseClaudeCodeModel(model: string): ClaudeCodeModelSpec {
  if (!isClaudeCodeModel(model)) {
    throw new Error(`Not a Claude Code model: ${model}`);
  }
  const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model);
  const [family, contextRaw] = baseModel.slice(PREFIX.length).trim().toLowerCase().split("@", 2);
  if (!isClaudeFamily(family)) {
    throw new Error(
      `Unsupported Claude Code model '${model}'. Use claude-code/fable, claude-code/opus, claude-code/sonnet, or claude-code/haiku.`,
    );
  }
  const context = resolveContext(family, contextRaw, model);
  const thinking = nonempty(thinkingSuffix) ? thinkingSuffix.slice(1) : undefined;
  return {
    inputModel: model,
    family,
    context,
    ...(nonempty(thinking) && thinking !== "off" ? { thinking } : {}),
    cliModel:
      context === "1m" && (family === "opus" || family === "sonnet") ? `${family}[1m]` : family,
    ...(context === "300k" ? { autoCompactWindow: "300000" } : {}),
  };
}
