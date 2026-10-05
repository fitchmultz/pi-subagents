import type { Writable } from "type-fest";

export interface InlineConfig {
  readonly output?: string | false;
  readonly outputMode?: "inline" | "file-only";
  readonly reads?: readonly string[] | false;
  readonly model?: string;
  readonly skill?: readonly string[] | false;
  readonly progress?: boolean;
}

export interface ParsedStep {
  readonly name: string;
  readonly config: InlineConfig;
  readonly task?: string;
}

export interface ExecutionFlags {
  readonly args: string;
  readonly async?: boolean;
  readonly fork: boolean;
  readonly error?: string;
}

function inlineOption(key: string, value: string): InlineConfig {
  switch (key) {
    case "output":
      return { output: value === "false" ? false : value };
    case "outputMode":
      if (value !== "inline" && value !== "file-only") {
        throw new Error("outputMode must be inline or file-only.");
      }
      return { outputMode: value };
    case "reads":
      return {
        reads: value === "false" ? false : value.split("+").filter((item) => item.length > 0),
      };
    case "model":
      return { model: value.length > 0 ? value : undefined };
    case "skill":
    case "skills":
      return {
        skill: value === "false" ? false : value.split("+").filter((item) => item.length > 0),
      };
    case "progress":
      if (value !== "true" && value !== "false") {
        throw new Error("progress must be true or false.");
      }
      return { progress: value === "true" };
    default:
      throw new Error(`Unknown inline option '${key}'.`);
  }
}

function parseInlineConfig(raw: string): InlineConfig {
  const config: Writable<InlineConfig> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      if (trimmed !== "progress") {
        throw new Error(`Unknown inline option '${trimmed}'.`);
      }
      config.progress = true;
    } else {
      Object.assign(
        config,
        inlineOption(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()),
      );
    }
  }
  return config;
}

export function parseAgentToken(token: string): ParsedStep {
  const bracket = token.indexOf("[");
  if (bracket === -1) {
    return { name: token, config: {} };
  }
  const end = token.lastIndexOf("]");
  if (end !== token.length - 1 || end < bracket) {
    throw new Error(`Malformed inline options in '${token}'; close the trailing ].`);
  }
  const name = token.slice(0, bracket);
  if (name.length === 0) {
    throw new Error("Agent name is required before inline options.");
  }
  return { name, config: parseInlineConfig(token.slice(bracket + 1, end)) };
}

export function extractExecutionFlags(rawArgs: string): ExecutionFlags {
  let args = rawArgs.trim();
  let asyncMode: boolean | undefined;
  let fork = false;
  while (true) {
    const match = args.match(/(?:^| )(--bg|--fg|--fork)$/);
    if (!match) {
      break;
    }
    const flag = match.at(1);
    if (flag === "--fork") {
      fork = true;
    } else {
      const nextAsync = flag === "--bg";
      if (asyncMode !== undefined && asyncMode !== nextAsync) {
        return { args, fork, error: "Choose only one of --bg or --fg" };
      }
      asyncMode = nextAsync;
    }
    args = args.slice(0, match.index).trim();
  }
  return { args, async: asyncMode, fork };
}

function parseSegment(segment: string): ParsedStep {
  const trimmed = segment.trim();
  const quoted = trimmed.match(/^(\S+(?:\[[^\]]*\])?)\s+(?:"([^"]*)"|'([^']*)')$/);
  if (quoted) {
    const agent = quoted.at(1) ?? "";
    const task = quoted.at(2) ?? quoted.at(3) ?? "";
    return { ...parseAgentToken(agent), task: task.length > 0 ? task : undefined };
  }
  const delimiter = trimmed.indexOf(" -- ");
  if (delimiter === -1) {
    return parseAgentToken(trimmed);
  }
  const task = trimmed.slice(delimiter + 4).trim();
  return {
    ...parseAgentToken(trimmed.slice(0, delimiter).trim()),
    task: task.length > 0 ? task : undefined,
  };
}

function sharedArguments(input: string, usage: string): { steps: ParsedStep[]; task: string } {
  const delimiter = input.indexOf(" -- ");
  if (delimiter === -1) {
    throw new Error(usage);
  }
  const agents = input.slice(0, delimiter).trim();
  const task = input.slice(delimiter + 4).trim();
  if (agents.length === 0 || task.length === 0) {
    throw new Error(usage);
  }
  return {
    steps: agents
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map(parseAgentToken),
    task,
  };
}

function hasTask(step: ParsedStep | undefined): boolean {
  return step?.task !== undefined && step.task.length > 0;
}

export interface ParsedAgentArgs {
  readonly steps: readonly ParsedStep[];
  readonly task: string;
  readonly perStep: boolean;
}

export function assertCommandTask(parsed: ParsedAgentArgs, command: "chain" | "parallel"): void {
  const { steps, task, perStep } = parsed;
  if (command === "chain" && !hasTask(steps.at(0)) && (perStep || task.length === 0)) {
    throw new Error('First step must have a task: /chain agent "task" -> agent2');
  }
  if (command === "parallel" && !steps.some(hasTask) && task.length === 0) {
    throw new Error("At least one step must have a task");
  }
}

export function parseAgentArgs(args: string, command: "chain" | "parallel"): ParsedAgentArgs {
  const input = args.trim();
  const usage = `Usage: /${command} agent1 "task1" -> agent2 "task2"`;
  const perStep = input.includes(" -> ");
  const parsed = perStep
    ? {
        steps: input
          .split(" -> ")
          .filter((segment) => segment.trim().length > 0)
          .map(parseSegment),
      }
    : sharedArguments(input, usage);
  const task = "task" in parsed ? parsed.task : (parsed.steps.find(hasTask)?.task ?? "");
  if (parsed.steps.length === 0) {
    throw new Error(usage);
  }
  return { steps: parsed.steps, task, perStep };
}

export function parseSingleArgs(args: string): { agent: ParsedStep; task: string } {
  const input = args.trim();
  if (input.length === 0) {
    throw new Error("Usage: /run <agent> [task] [--bg|--fg] [--fork]");
  }
  const space = input.indexOf(" ");
  const rawTask = space === -1 ? "" : input.slice(space + 1).trim();
  const quoted = rawTask.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  return {
    agent: parseAgentToken(space === -1 ? input : input.slice(0, space)),
    task: quoted ? (quoted.at(1) ?? quoted.at(2) ?? "") : rawTask,
  };
}

export function parseSavedChainArgs(args: string): { name: string; task: string } {
  const delimiter = args.indexOf(" -- ");
  const usage = "Usage: /run-chain <chainName> -- <task> [--bg|--fg] [--fork]";
  if (delimiter === -1) {
    throw new Error(usage);
  }
  const name = args.slice(0, delimiter).trim();
  const task = args.slice(delimiter + 4).trim();
  if (name.length === 0 || task.length === 0) {
    throw new Error(usage);
  }
  return { name, task };
}

export function inlineOverrides(config: InlineConfig): InlineConfig {
  return {
    ...(config.output !== undefined ? { output: config.output } : {}),
    ...(config.outputMode !== undefined ? { outputMode: config.outputMode } : {}),
    ...(config.reads !== undefined ? { reads: config.reads } : {}),
    ...(config.model !== undefined && config.model.length > 0 ? { model: config.model } : {}),
    ...(config.skill !== undefined ? { skill: config.skill } : {}),
    ...(config.progress !== undefined ? { progress: config.progress } : {}),
  };
}
