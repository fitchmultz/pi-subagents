import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "./contracts.ts";
import { renderCompactResult } from "../shared/compact-cards.ts";
import { isRecord } from "../shared/unknown.ts";

// Main-session tool parameters only; the detached runner must not load pi-ai values.
export const delegateSchema = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      description:
        "Required complete assignment for the child: what to accomplish, settled product decisions, non-goals, and stop boundary so the child does not invent design choices or extra scope.",
    }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Exact provider/model ID (:thinking and any case need host support); no fuzzy match or fallback.",
      }),
    ),
    thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
    context: Type.Optional(StringEnum(["fresh", "fork"] as const)),
    readOnly: Type.Optional(
      Type.Boolean({
        description:
          "When true, disable file-editing tools for this child (use for research, audits, or review; shell commands are not OS-sandboxed).",
      }),
    ),
  },
  { additionalProperties: false },
);
export type DelegateInput = Static<typeof delegateSchema>;

export const runsSchema = Type.Object(
  {
    action: StringEnum(["list", "inspect", "continue", "stop"] as const),
    id: Type.Optional(Type.String()),
    prompt: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Complete prompt for continue. Omit when approving a paused overseer checkpoint without extra steering; include to steer a live/paused child or resume a settled conversation.",
      }),
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    length: Type.Optional(Type.Integer({ minimum: 4, maximum: 262144 })),
  },
  { additionalProperties: false },
);
export type RunsInput = Static<typeof runsSchema>;

/**
 * A codemode script receives `structuredContent` from a tool that declares an output schema.
 * Only `list` sets it, to its JSON inventory; the other actions resolve to their model text.
 */
export const runsOutputSchema = Type.String();

function prepareDelegateArguments(args: unknown): unknown {
  if (!isRecord(args) || (args.model !== "null" && args.thinking !== "null")) {
    return args;
  }
  const prepared = { ...args };
  if (prepared.model === "null") {
    delete prepared.model;
  }
  if (prepared.thinking === "null") {
    delete prepared.thinking;
  }
  return prepared;
}

export function registerAgentTools(
  pi: ExtensionAPI,
  child: boolean,
  executeDelegate: ToolDefinition<typeof delegateSchema>["execute"],
  executeRuns: ToolDefinition<typeof runsSchema>["execute"],
): void {
  // The hook returns raw input; Pi validates it with delegateSchema before calling executeDelegate.
  const delegateTool: ToolDefinition = {
    name: "delegate",
    label: "Delegate",
    description:
      "Run a child on exactly this prompt; main sessions only. Fork copies the full conversation; default is fresh. Pass readOnly: true to disable edit tools for recon/review. Returns a receipt; completion is notified later: do other work or end the turn, don't poll.",
    parameters: delegateSchema,
    prepareArguments: prepareDelegateArguments,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    exposure: child ? "hidden" : "direct",
    renderResult: renderCompactResult,
    execute: executeDelegate,
  };
  pi.registerTool(delegateTool);
  pi.registerTool({
    name: "agent_runs",
    label: "Agent runs",
    description:
      "Manage your child runs without waiting; completions and overseer checkpoints are notified. Inspect pages by byte offset, never interrupting. Continue steers a live/paused child or resumes a settled conversation; on a paused overseer checkpoint, omit prompt to approve and resume or include prompt to steer with corrections.",
    parameters: runsSchema,
    outputSchema: runsOutputSchema,
    exposure: child ? "hidden" : "direct",
    renderResult: renderCompactResult,
    execute: executeRuns,
  });
}
