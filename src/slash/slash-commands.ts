import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { errorMessage } from "../shared/unknown.ts";
import { resolveExecutionCwd } from "../shared/execution-cwd.ts";
import {
  assertCommandTask,
  extractExecutionFlags,
  inlineOverrides,
  parseAgentArgs,
  parseSavedChainArgs,
  parseSingleArgs,
  type ExecutionFlags,
} from "./command-input.ts";
import {
  assertKnownAgents,
  discoverSavedChains,
  makeAgentCompletions,
  makeChainCompletions,
  type SlashDiscoveryState,
} from "./command-discovery.ts";
import { mapSavedChainSteps } from "./saved-chain.ts";
import { runSlashSubagent } from "./result-delivery.ts";

type Params = ReadonlyInput<SubagentParamsLike>;

function executionFlags(args: string): ExecutionFlags {
  const flags = extractExecutionFlags(args);
  if (flags.error !== undefined) {
    throw new Error(flags.error);
  }
  return flags;
}

function executionOverrides(flags: ExecutionFlags): Pick<Params, "async" | "context"> {
  return {
    ...(flags.async !== undefined ? { async: flags.async } : {}),
    ...(flags.fork ? { context: "fork" } : {}),
  };
}

function commandHandler(
  execute: (args: string, ctx: ExtensionContext) => Promise<void>,
): (args: string, ctx: ExtensionContext) => Promise<void> {
  return async (args, ctx) => {
    try {
      await execute(args, ctx);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
    }
  };
}

async function runSingle(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const flags = executionFlags(args);
  const { agent, task } = parseSingleArgs(flags.args);
  const cwd = resolveExecutionCwd(pi, ctx);
  assertKnownAgents(cwd, [agent.name], ctx.isProjectTrusted());
  const { reads, ...overrides } = inlineOverrides(agent.config);
  const finalTask =
    reads !== undefined && reads !== false && reads.length > 0
      ? `[Read from: ${reads.join(", ")}]\n\n${task}`
      : task;
  const params: Params = {
    agent: agent.name,
    task: finalTask,
    clarify: false,
    agentScope: "both",
    ...overrides,
    ...executionOverrides(flags),
  };
  await runSlashSubagent(pi, ctx, params, cwd);
}

async function runChain(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const flags = executionFlags(args);
  const cwd = resolveExecutionCwd(pi, ctx);
  const parsed = parseAgentArgs(flags.args, "chain");
  assertKnownAgents(
    cwd,
    parsed.steps.map((step) => step.name),
    ctx.isProjectTrusted(),
  );
  assertCommandTask(parsed, "chain");
  const chain = parsed.steps.map((step, index) => {
    const task = step.task ?? (index === 0 && parsed.task.length > 0 ? parsed.task : undefined);
    return {
      agent: step.name,
      ...(task !== undefined ? { task } : {}),
      ...inlineOverrides(step.config),
    };
  });
  await runSlashSubagent(
    pi,
    ctx,
    {
      chain,
      task: parsed.task,
      clarify: false,
      agentScope: "both",
      ...executionOverrides(flags),
    },
    cwd,
  );
}

async function runParallel(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const flags = executionFlags(args);
  const cwd = resolveExecutionCwd(pi, ctx);
  const parsed = parseAgentArgs(flags.args, "parallel");
  assertKnownAgents(
    cwd,
    parsed.steps.map((step) => step.name),
    ctx.isProjectTrusted(),
  );
  assertCommandTask(parsed, "parallel");
  const tasks = parsed.steps.map((step) =>
    Object.assign(
      { agent: step.name, task: step.task ?? parsed.task },
      inlineOverrides(step.config),
    ),
  );
  await runSlashSubagent(
    pi,
    ctx,
    {
      tasks,
      clarify: false,
      agentScope: "both",
      ...executionOverrides(flags),
    },
    cwd,
  );
}

async function runSavedChain(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const flags = executionFlags(args);
  const { name, task } = parseSavedChainArgs(flags.args);
  const cwd = resolveExecutionCwd(pi, ctx);
  const chain = discoverSavedChains(cwd, ctx.isProjectTrusted()).find(
    (candidate) => candidate.name === name,
  );
  if (!chain) {
    throw new Error(`Unknown chain: ${name}`);
  }
  let steps: ReturnType<typeof mapSavedChainSteps>;
  try {
    steps = mapSavedChainSteps(chain);
  } catch (error) {
    ctx.ui.notify(`Cannot load chain '${name}': ${errorMessage(error)}`, "error");
    return;
  }
  await runSlashSubagent(
    pi,
    ctx,
    {
      chain: steps,
      task,
      clarify: false,
      agentScope: "both",
      ...executionOverrides(flags),
    },
    cwd,
  );
}

export function registerSlashCommands(pi: ExtensionAPI, state: SlashDiscoveryState): void {
  pi.registerCommand("run", {
    description: "Run a subagent directly: /run agent[output=file] [task] [--bg|--fg] [--fork]",
    getArgumentCompletions: makeAgentCompletions(pi, state, false),
    handler: commandHandler((args, ctx) => runSingle(pi, args, ctx)),
  });
  pi.registerCommand("chain", {
    description: 'Run agents in sequence: /chain scout "task" -> oracle [--bg|--fg] [--fork]',
    getArgumentCompletions: makeAgentCompletions(pi, state, true),
    handler: commandHandler((args, ctx) => runChain(pi, args, ctx)),
  });
  pi.registerCommand("run-chain", {
    description: "Run a saved chain: /run-chain chainName -- task [--bg|--fg] [--fork]",
    getArgumentCompletions: makeChainCompletions(pi, state),
    handler: commandHandler((args, ctx) => runSavedChain(pi, args, ctx)),
  });
  pi.registerCommand("parallel", {
    description:
      'Run agents in parallel: /parallel scout "task1" -> oracle "task2" [--bg|--fg] [--fork]',
    getArgumentCompletions: makeAgentCompletions(pi, state, true),
    handler: commandHandler((args, ctx) => runParallel(pi, args, ctx)),
  });
  pi.registerCommand("subagents-doctor", {
    description: "Show subagent diagnostics",
    handler: async (_args, ctx) => {
      await runSlashSubagent(pi, ctx, { action: "doctor" });
    },
  });
}
