import { Type } from "../shared/native-typebox.ts";
import { AcceptanceOverride } from "./acceptance-schema.ts";

export const requiredObject = (
  ...required: readonly string[]
): { type: "object"; required: readonly string[] } => ({ type: "object", required });

export const SkillOverride = Type.Unsafe({
  anyOf: [
    { type: "array", items: { type: "string", minLength: 1 } },
    { type: "boolean" },
    { type: "string" },
  ],
  description: "Skill name(s): string, comma-separated string, array, or false to disable",
});

export const OutputOverride = Type.Unsafe({
  anyOf: [{ type: "string", minLength: 1 }, { type: "boolean" }],
  description: "Output file path, or false to disable file output.",
});

export const OutputModeOverride = Type.Enum(["inline", "file-only"] as const, {
  type: "string",
  description: "inline (default) or file-only; file-only requires output to be a path.",
});

export const ReadsOverride = Type.Unsafe({
  anyOf: [{ type: "array", items: { type: "string", minLength: 1 } }, { type: "boolean" }],
  description: "Files to read before running, or false to disable",
});

export const JsonSchemaObject = Type.Unsafe({
  type: "object",
  additionalProperties: true,
  description: "JSON Schema (object root) for strict structured output.",
});

export const ModelOverride = Type.Optional(
  Type.String({
    description:
      'Profiles are defaults; warranted overrides are allowed subject to user instructions and provider authorization. Use model: "provider/model:high" to pin route/effort (no profile fallbacks; same-choice transport retries remain). Omit for profile fallbacks. No standalone thinking argument.',
  }),
);

export const TaskItem = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    task: Type.String({ minLength: 1 }),
    label: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Short task label for the Agents strip and conversation.",
      }),
    ),
    cwd: Type.Optional(Type.String()),
    count: Type.Optional(
      Type.Integer({ minimum: 1, description: "Repeat this parallel task N times." }),
    ),
    outputSchema: Type.Optional(JsonSchemaObject),
    output: Type.Optional(OutputOverride),
    outputMode: Type.Optional(OutputModeOverride),
    reads: Type.Optional(ReadsOverride),
    progress: Type.Optional(
      Type.Boolean({ description: "Enable progress.md tracking for this task" }),
    ),
    model: ModelOverride,
    skill: Type.Optional(SkillOverride),
    acceptance: Type.Optional(AcceptanceOverride),
  },
  { additionalProperties: false },
);

export const HistoryQueryFields = {
  cursor: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Opaque page cursor returned by list/history/search; expires when the indexed snapshot changes.",
    }),
  ),
  sort: Type.Optional(
    Type.Enum(["attention", "newest", "oldest", "relevance"] as const, {
      type: "string",
      description:
        "List: attention (default), newest, oldest. Search: relevance (default), newest.",
    }),
  ),
  state: Type.Optional(
    Type.Enum(["live", "completed", "failed", "blocked", "paused", "unknown"] as const, {
      type: "string",
      description: "List only: execution-state filter, applied before paging.",
    }),
  ),
  text: Type.Optional(
    Type.String({
      minLength: 1,
      description: "List only: filter saved task/assignment text before paging.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Search visible saved text using 1–12 lexical words (all must match) or one double-quoted phrase. Operators, punctuation and prefixes are rejected. Thinking, images, tool arguments and hidden data are excluded.",
    }),
  ),
  before: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "History only: exclusive native-entry position returned by the earlier page; omit for the latest page.",
    }),
  ),
};
