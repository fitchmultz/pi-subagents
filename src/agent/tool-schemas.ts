import { runContractSchema } from "../shared/amendment-schema.ts";
import type { Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "./typebox.ts";
import { THINKING_LEVELS } from "./contracts.ts";
import { renderCompactResult } from "../shared/compact-cards.ts";

// Main-session tool parameters only; the detached runner must not load pi-ai values.
export const delegateContractSchema = Type.Object(
  {
    scope: Type.Array(Type.String({ minLength: 1 }), {
      description:
        "Allowed relative edit-tool path prefixes or globs inside cwd (e.g. 'src', 'src/foo.ts', 'src/**', 'test/**/*.test.ts', '{src,test}/**', '*.ts'), ['*'] for any edit path in cwd, or [] to disable repo edits while still allowing edit tools in the run's private scratch directory (shell commands are not sandboxed).",
    }),
    verification: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Checks required before completion (required when scope is non-empty).",
      }),
    ),
    baseBranch: Type.Optional(
      Type.String({ minLength: 1, description: "Expected Git base branch or ref." }),
    ),
    requiredPrimitives: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Existing language/package APIs the child must use instead of custom shims.",
      }),
    ),
    nonGoals: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Out-of-scope edits or forbidden workarounds.",
      }),
    ),
  },
  { additionalProperties: false },
);
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
    contract: Type.Optional(delegateContractSchema),
  },
  { additionalProperties: false },
);
export type DelegateInput = Static<typeof delegateSchema>;
export type RunContractInput = Static<typeof runContractSchema>;
export const runsSchema = Type.Object(
  {
    action: StringEnum(["list", "inspect", "continue", "stop", "review"] as const),
    id: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    verdict: Type.Optional(StringEnum(["approved", "changes_requested"] as const)),
    summary: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'With "approved", save review evidence without sending it to the child. With "changes_requested", use the summary as the child’s correction or next prompt.',
      }),
    ),
    note: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'With action="review" and verdict="approved" on a running or paused child, queue this follow-up steering note for the child in the same call while keeping summary review-only. Rejected for other actions, other verdicts, or settled runs.',
      }),
    ),
    contract: Type.Optional(runContractSchema),
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

export function registerAgentTools(
  pi: ExtensionAPI,
  child: boolean,
  executeDelegate: ToolDefinition<typeof delegateSchema>["execute"],
  executeRuns: ToolDefinition<typeof runsSchema>["execute"],
): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Run a child on exactly this prompt; main sessions only. Fork copies the full conversation; default is fresh. Optional thinking overrides inherited effort for this child. Returns a receipt; completion is notified later: do other work or end the turn, don't poll.",
    parameters: delegateSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    exposure: child ? "hidden" : "direct",
    renderResult: renderCompactResult,
    execute: executeDelegate,
  });
  pi.registerTool({
    name: "agent_runs",
    label: "Agent runs",
    description:
      'Manage your child runs without waiting; completions are notified. Inspect pages by byte offset, never interrupting. Continue takes the complete new prompt (and optional contract amendment): it steers a live/paused child or resumes the saved conversation. Review with "approved" records the summary without sending it (and accepts an optional steering note for a running or paused child); "changes_requested" uses the summary as the new prompt and also accepts an optional contract amendment.',
    parameters: runsSchema,
    outputSchema: runsOutputSchema,
    exposure: child ? "hidden" : "direct",
    renderResult: renderCompactResult,
    execute: executeRuns,
  });
}
