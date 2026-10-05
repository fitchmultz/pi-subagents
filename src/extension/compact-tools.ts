import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "../shared/native-typebox.ts";
import {
  type createSubagentExecutor,
  normalizeSubagentParamsLike,
} from "../runs/foreground/subagent-executor.ts";
import type { SubagentExecutionResult } from "../shared/types.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { activateTools, restoreLazyTools } from "../shared/lazy-tools.ts";
import type { HistoryRunOptions } from "../history/types.ts";
import { listSupervisorQuestionsAsync } from "../runs/shared/supervisor-questions.ts";
import { renderSubagentResult } from "../tui/render.ts";
import { AgentRunsParams, DelegateParams } from "./schemas.ts";
import { normalizeEverydayParams } from "./tool-input.ts";

type Executor = ReturnType<typeof createSubagentExecutor>;
type AdaptResult = (
  result: ReadonlyInput<SubagentExecutionResult>,
  ctx: ExtensionContext,
) => SubagentExecutionResult;
type ControlsIndex = { readonly needsControls: () => Promise<boolean> };
interface RunControlsState {
  readonly ownedRuns?: { readonly size: number };
  readonly lastUiContext: ExtensionContext | null;
  readonly currentSessionId: string | null;
  readonly historyIndex?: unknown;
}
interface ExecutionOptions {
  readonly executor: Readonly<Executor>;
  readonly adapt: AdaptResult;
  readonly listRuns?: (
    params: ReadonlyInput<HistoryRunOptions>,
    ctx: ExtensionContext,
  ) => Promise<SubagentExecutionResult>;
}
interface CompactOptions extends ExecutionOptions {
  readonly state: RunControlsState;
  readonly getHistoryIndex: () => Promise<ControlsIndex>;
  readonly guidelines: readonly string[];
  readonly childSafe?: boolean;
  readonly keepAdvancedActive?: boolean;
  readonly asyncByDefault: boolean;
}

function hasOwnedRunsFor(state: RunControlsState, owner: string | null): boolean {
  return (
    (state.lastUiContext?.sessionManager.getSessionId() ?? state.currentSessionId) === owner &&
    (state.ownedRuns?.size ?? 0) > 0
  );
}

async function activateOwnedControls(
  pi: ExtensionAPI,
  state: RunControlsState,
  getHistoryIndex: () => Promise<ControlsIndex>,
  owner: string | null,
): Promise<void> {
  try {
    const index = await getHistoryIndex();
    const needed = await index.needsControls();
    if (state.historyIndex === index && needed) {
      activateTools(pi, ["agent_runs"]);
    }
  } catch {
    // An unavailable browse index cannot establish that genuine owned work is inert.
    if (hasOwnedRunsFor(state, owner)) {
      activateTools(pi, ["agent_runs"]);
    }
  }
}

function createRunControlsReconciler(
  pi: ExtensionAPI,
  state: RunControlsState,
  getHistoryIndex: () => Promise<ControlsIndex>,
): () => Promise<void> {
  let checking: { readonly owner: string | null; readonly promise: Promise<void> } | undefined;
  return (): Promise<void> => {
    if (pi.getActiveTools().includes("agent_runs") || (state.ownedRuns?.size ?? 0) === 0) {
      return Promise.resolve();
    }
    const owner = state.lastUiContext?.sessionManager.getSessionId() ?? state.currentSessionId;
    if (checking?.owner === owner) {
      return checking.promise;
    }
    const promise = activateOwnedControls(pi, state, getHistoryIndex, owner);
    checking = { owner, promise };
    promise
      .finally(() => {
        if (checking?.promise === promise) {
          checking = undefined;
        }
      })
      .catch((error: unknown) => {
        console.error("Could not reconcile owned subagent controls:", error);
      });
    return promise;
  };
}

function registerDelegate(
  pi: ExtensionAPI,
  options: Pick<
    CompactOptions,
    "executor" | "adapt" | "guidelines" | "childSafe" | "asyncByDefault"
  >,
  checkRuns: () => Promise<void>,
): void {
  const asyncDescription = options.asyncByDefault
    ? "Background by default; false waits for the result."
    : "Foreground by default; true detaches work. Use false when the result must appear in your report.";
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: `Delegate one bounded task to a configured agent. For profiles/history, load_subagent({advanced:false}) enables agent_runs. Delegation enables run controls automatically. ${asyncDescription} Use worktree for an isolated writer, acceptance for explicit requirements, and fresh context for independent review. Fresh handoffs must include relevant exact user instructions and settled decisions or readable source references, not just summaries, alongside the bounded task. Advanced workflows remain behind load_subagent.`,
    ...(options.childSafe === true ? { promptGuidelines: [...options.guidelines] } : {}),
    parameters: Type.Object(
      {
        ...DelegateParams.properties,
        async: Type.Optional(Type.Boolean({ description: asyncDescription })),
      },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, onUpdate, ctx) {
      const { worktree, context, async: background, ...task } = normalizeEverydayParams(params);
      const request =
        worktree === true
          ? { tasks: [task], worktree: true, context, async: background, cwd: task.cwd }
          : { ...task, context, async: background };
      const result = await options.executor.execute({
        toolCallId: id,
        params: normalizeSubagentParamsLike(request),
        signal,
        onUpdate,
        ctx,
      });
      await checkRuns();
      return options.adapt(result, ctx);
    },
    renderResult: renderSubagentResult,
  });
}

function registerRuns(pi: ExtensionAPI, options: ExecutionOptions, childSafe: boolean): void {
  pi.registerTool({
    name: "agent_runs",
    defaultActive: false,
    label: "Agent Runs",
    description: `List ${childSafe ? "only this child's directly owned" : "your delegated"} runs across working directories (questions/failures, then live work, then unreviewed results; 20 per page). Filter globally by agent/state/text, sort, and page with the returned cursor. history reads 100 bounded native-entry previews; search finds saved visible text using words or quoted phrases, not operators or prefixes. Browse freshness is not completion or delivery proof. Inspect concise results, paths and continuations; full:true includes the full task/configuration. Answer durable questions, nudge, stop, continue, or save parent-only review. Review notes are not sent to children; put actionable instructions in continue/nudge. Inspect/review/nudge never restart finished work. Continue/answer can launch a saved child; async:false waits for its actual result. Saved continuations keep settings unless agent selects a current profile; model overrides win. Live guidance never mutates model or acceptance. profiles lists roles, sources, context and model/thinking/fallback defaults. History survives reload.`,
    parameters: AgentRunsParams,
    async execute(id, params, signal, onUpdate, ctx) {
      const normalized = normalizeEverydayParams(params, true);
      if (params.action === "list" && params.id === undefined && options.listRuns) {
        return options.adapt(await options.listRuns({ ...normalized, signal }, ctx), ctx);
      }
      const actions = {
        list: "status",
        inspect: "status",
        history: "history",
        search: "search",
        nudge: "nudge",
        stop: "interrupt",
        continue: "resume",
        profiles: "list",
        questions: "questions",
        answer: "answer",
        review: "review",
      };
      return options.adapt(
        await options.executor.execute({
          toolCallId: id,
          params: normalizeSubagentParamsLike({ ...normalized, action: actions[params.action] }),
          signal,
          onUpdate,
          ctx,
        }),
        ctx,
      );
    },
    renderResult: renderSubagentResult,
  });
}

function requireAvailableTool(pi: ExtensionAPI, name: string, error: string): void {
  if (
    !pi.getAllTools().some((tool) => tool.name === name && !("namespace" in tool && tool.namespace))
  ) {
    throw new Error(error);
  }
}

function registerLoader(
  pi: ExtensionAPI,
  options: Pick<CompactOptions, "guidelines" | "childSafe">,
): void {
  pi.registerTool({
    name: "load_subagent",
    label: "Load Subagent",
    description: `Enable agent_runs for profiles, history and run controls; advanced:false loads only those controls. By default also enable advanced subagent orchestration: parallel groups, chains, saved workflows, detailed overrides, get, extend and doctor.${options.childSafe === true ? " Agent-definition mutations remain blocked." : " Includes agent-definition management."} Ordinary delegation and control use delegate and agent_runs. After loading advanced workflows, call subagent with { action: "list" } before execution.`,
    promptSnippet:
      "Discover profiles/history with advanced:false, or load full subagent orchestration by default.",
    parameters: Type.Object({
      advanced: Type.Optional(
        Type.Boolean({
          description:
            "Also enable advanced orchestration (default true); false loads only agent_runs for profiles, history and controls.",
        }),
      ),
    }),
    async execute(_id, params) {
      const advanced = params.advanced !== false;
      requireAvailableTool(
        pi,
        advanced ? "subagent" : "agent_runs",
        advanced
          ? "Subagent is unavailable because the full tool is excluded from this session."
          : "Run controls are excluded from this session.",
      );
      const added = !pi.getActiveTools().includes(advanced ? "subagent" : "agent_runs");
      activateTools(pi, advanced ? ["agent_runs", "subagent"] : ["agent_runs"]);
      return {
        content: [
          {
            type: "text",
            text: advanced
              ? [
                  `Subagent ${added ? "enabled" : "already enabled"}.`,
                  ...options.guidelines.map((line) => `- ${line}`),
                ].join("\n")
              : "Run controls enabled. Use agent_runs({action:'profiles'}) to discover agents; list, history, or search browses owned saved work.",
          },
        ],
        details: {},
      };
    },
  });
}

export function registerCompactSubagentTools(
  pi: ExtensionAPI,
  options: CompactOptions,
): () => Promise<void> {
  const checkRuns = createRunControlsReconciler(pi, options.state, options.getHistoryIndex);
  registerDelegate(pi, options, checkRuns);
  registerRuns(pi, options, options.childSafe === true);
  registerLoader(pi, options);
  const reconcile = async (ctx: ExtensionContext): Promise<void> => {
    if (options.keepAdvancedActive === true) {
      activateTools(pi, ["subagent"]);
    }
    await checkRuns();
    if (
      !pi.getActiveTools().includes("agent_runs") &&
      (await listSupervisorQuestionsAsync(ctx.sessionManager.getSessionId())).some(
        (question) => question.state === "awaiting_input" || question.state === "answer_pending",
      )
    ) {
      activateTools(pi, ["agent_runs"]);
    }
  };
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "reload") {
      restoreLazyTools(pi, ctx, "load_subagent", ["subagent", "agent_runs"]);
    }
    await reconcile(ctx);
  });
  pi.on("session_tree", (_event, ctx) => reconcile(ctx));
  pi.on("session_compact", (_event, ctx) => reconcile(ctx));
  pi.on("before_agent_start", (_event, ctx) => reconcile(ctx));
  return checkRuns;
}
