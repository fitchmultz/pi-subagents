import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import {
  normalizeSubagentParamsLike,
  resolveAsyncExecutionMode,
  type createSubagentExecutor,
} from "../runs/foreground/subagent-executor.ts";
import { applyForceTopLevelAsyncOverride } from "../runs/background/top-level-async.ts";
import { renderSubagentResult } from "../tui/render.ts";
import type { ReadonlyDetails, SubagentExecutionResult, ExtensionConfig } from "../shared/types.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { SubagentParams } from "./schemas.ts";

export const SUBAGENT_GUIDELINES = [
  "Use subagent for materially parallelizable scouting, review, or implementation work where another focused agent adds value.",
  "Top-level subagent execution uses the stock async default unless configuration opts out. Launch a small bounded fanout of independent agents as separate single-agent runs so each completion wakes the parent, with at most one writer. Use one tasks call for non-review fanout when all child results are required together, when shared concurrency/task limits are needed, or when multiple writers require worktree isolation; the parent receives one aggregate completion. If no useful parent work remains, end the turn and wait instead of polling; completion wakes the parent. This also applies when an incomplete active Pi goal needs child evidence: yield, then continue the goal after automatic completion delivery. Set async:false only for explicitly chosen foreground execution.",
  'Before executing subagent runs, call subagent with { action: "list" } unless the requested executable agent or chain is already known from this conversation.',
  "Keep the parent session responsible for final decisions, verification, and user-facing status; treat subagent output as evidence to review, not automatic truth.",
  "Fresh-child handoffs must include relevant exact user instructions and settled decisions or readable source references alongside the bounded task; summaries do not replace original requirements.",
  "Keep independent review as a separate parent-launched reviewer run after the worker; acceptance.review is unsupported.",
  "For review-only tasks, omit acceptance unless the user explicitly requests a same-session acceptance contract; acceptance adds a finalization turn and is not independent review.",
  "For live child guidance, answers, corrections, or blockers, inspect status and prefer action='nudge'; it sends a non-blocking steer that supplements the active task unless the message explicitly replaces it. Use the shown blocking intercom ask only when the parent must stay alive waiting for a reply.",
  "Do not use subagent when a direct local tool call or small edit is cheaper than delegation.",
] as const;

interface ParentToolOptions {
  readonly executor: Readonly<ReturnType<typeof createSubagentExecutor>>;
  readonly adapt: (
    result: ReadonlyInput<SubagentExecutionResult>,
    ctx: ExtensionContext,
  ) => SubagentExecutionResult;
  readonly config: ExtensionConfig;
  readonly asyncByDefault: boolean;
}

function effectiveParallelTaskCount(
  tasks: readonly { readonly count?: unknown }[] | undefined,
): number {
  return (
    tasks?.reduce(
      (total, task) =>
        total +
        (typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1
          ? task.count
          : 1),
      0,
    ) ?? 0
  );
}

type RenderArgs = ReadonlyInput<Partial<Static<typeof SubagentParams>>>;

function renderManagement(args: RenderArgs & { readonly action: string }, theme: Theme): Text {
  const agent = args.agent ?? "";
  const target = agent.length > 0 ? agent : (args.chainName ?? "");
  const title = theme.fg("toolTitle", theme.bold("subagent "));
  return new Text(
    `${title}${args.action}${target.length > 0 ? ` ${theme.fg("accent", target)}` : ""}`,
    0,
    0,
  );
}

function renderExecution(
  args: RenderArgs,
  theme: Theme,
  options: Pick<ParentToolOptions, "config" | "asyncByDefault">,
): Text {
  const title = theme.fg("toolTitle", theme.bold("subagent "));
  const renderedArgs = applyForceTopLevelAsyncOverride(
    args,
    0,
    options.config.forceTopLevelAsync === true,
  );
  const asyncLabel = resolveAsyncExecutionMode(renderedArgs, options.asyncByDefault).effectiveAsync
    ? theme.fg("warning", " [async]")
    : "";
  if (args.chain !== undefined && args.chain.length > 0) {
    return new Text(`${title}chain (${args.chain.length})${asyncLabel}`, 0, 0);
  }
  if (args.tasks !== undefined && args.tasks.length > 0) {
    return new Text(
      `${title}parallel (${effectiveParallelTaskCount(args.tasks)})${asyncLabel}`,
      0,
      0,
    );
  }
  const agent = args.agent ?? "";
  return new Text(
    `${title}${theme.fg("accent", agent.length > 0 ? agent : "?")}${asyncLabel}`,
    0,
    0,
  );
}

export function registerParentSubagentTool(pi: ExtensionAPI, options: ParentToolOptions): void {
  const tool: ToolDefinition<typeof SubagentParams, ReadonlyDetails> = {
    name: "subagent",
    defaultActive: false,
    label: "Subagent",
    description: `Delegate bounded work to configured Pi subagents, chains, or parallel reviewers; manage agent definitions; inspect/control async runs. Indexed status lists support global agent/state/text filters and sort/cursors; history pages bounded native previews and search finds saved visible words or one quoted phrase. Browse freshness is not canonical proof. Use exactly one execution mode (agent, tasks, or chain) or one management/control action. Before execution, use { action: "list" } to inspect configured agents/chains. Only execute agents listed as executable/non-disabled. Parallel tasks support output?,reads?,progress?. maxOutput accepts { bytes?: number, lines?: number }. Prefer acceptance for goal/spec handoffs and status/resume/interrupt/extend/nudge for active runs. Exact status is concise by default; full:true includes the full task/configuration. Review notes are parent-only, not sent to children; put actionable instructions in resume/nudge. Resume/answer preserves saved settings unless agent selects a current profile (including model/thinking/fallbacks); a separate model override wins. Live guidance never mutates model or acceptance.`,
    parameters: SubagentParams,
    async execute(id, params, signal, onUpdate, ctx) {
      return options.adapt(
        await options.executor.execute({
          toolCallId: id,
          params: normalizeSubagentParamsLike(params),
          signal,
          onUpdate,
          ctx,
        }),
        ctx,
      );
    },
    renderCall: (args, theme) => {
      if (args.action !== undefined && args.action.length > 0) {
        return renderManagement({ ...args, action: args.action }, theme);
      }
      return renderExecution(args, theme, options);
    },
    renderResult: renderSubagentResult,
  };
  pi.registerTool(tool);
}
