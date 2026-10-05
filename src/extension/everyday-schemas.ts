import { Type } from "../shared/native-typebox.ts";
import { DelegateAcceptance } from "./acceptance-schema.ts";
import { HistoryQueryFields, TaskItem, requiredObject } from "./schema-overrides.ts";

export const DelegateParams = Type.Object(
  {
    agent: TaskItem.properties.agent,
    task: TaskItem.properties.task,
    label: TaskItem.properties.label,
    cwd: TaskItem.properties.cwd,
    model: TaskItem.properties.model,
    context: Type.Optional(
      Type.Enum(["fresh", "fork"] as const, {
        type: "string",
        description: "Override the profile's context policy.",
      }),
    ),
    async: Type.Optional(
      Type.Boolean({ description: "Background by default; false waits for the result." }),
    ),
    worktree: Type.Optional(
      Type.Boolean({
        description:
          "Isolate this writer in a Git worktree; return its patch. Requires a clean checkout.",
      }),
    ),
    output: TaskItem.properties.output,
    acceptance: Type.Optional(DelegateAcceptance),
  },
  { additionalProperties: false },
);

export const AgentRunsValidationParams = Type.Object(
  {
    action: Type.Enum(
      [
        "list",
        "inspect",
        "history",
        "search",
        "nudge",
        "stop",
        "continue",
        "profiles",
        "questions",
        "answer",
        "review",
      ] as const,
      { type: "string" },
    ),
    id: Type.Optional(Type.String({ minLength: 1, description: "Run ID or unambiguous prefix." })),
    questionId: Type.Optional(
      Type.String({ minLength: 1, description: "Durable supervisor question ID for answer." }),
    ),
    async: Type.Optional(
      Type.Boolean({
        description: "Continue/answer: false waits for the actual continuation result.",
      }),
    ),
    index: Type.Optional(
      Type.Integer({ minimum: 0, description: "Child index for a multi-child run." }),
    ),
    message: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Guidance, follow-up, answer, or optional parent-only review note. Review notes are not sent to the child; put actionable instructions in continue/nudge. Only continue/answer can start a saved child.",
      }),
    ),
    decision: Type.Optional(
      Type.Enum(["accepted", "needs_changes"] as const, {
        type: "string",
        description:
          "Parent-only review outcome; not sent to the child. Separate from execution and runtime acceptance checks.",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "List offset; history is retained regardless of page size.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: "Results per list/search/history page (default 20; history 100).",
      }),
    ),
    ...HistoryQueryFields,
    full: Type.Optional(
      Type.Boolean({
        description:
          "Inspect only: include the full task and saved launch configuration. Default is a concise report; stored data is unchanged.",
      }),
    ),
    agent: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "List/search: filter by child agent. Continue/answer: adopt this current profile, including model, thinking and fallbacks; a separate model override wins. Otherwise keep saved settings. Required for old runs without a saved profile.",
      }),
    ),
    model: TaskItem.properties.model,
    cwd: TaskItem.properties.cwd,
    output: TaskItem.properties.output,
    acceptance: TaskItem.properties.acceptance,
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: {
          properties: {
            action: {
              enum: ["inspect", "history", "nudge", "stop", "continue", "answer", "review"],
            },
          },
        },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("id"),
      },
      {
        if: { properties: { action: { enum: ["search"] } } },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("query"),
      },
      {
        if: { properties: { action: { enum: ["nudge", "continue", "answer"] } } },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("message"),
      },
      {
        if: { properties: { action: { enum: ["answer"] } } },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("questionId"),
      },
      {
        if: { properties: { action: { enum: ["review"] } } },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("decision"),
      },
      {
        if: {
          anyOf: [
            requiredObject("async"),
            requiredObject("model"),
            requiredObject("cwd"),
            requiredObject("output"),
            requiredObject("acceptance"),
          ],
        },

        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["continue", "answer"] } } },
      },
      {
        if: requiredObject("agent"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["list", "search", "continue", "answer"] } } },
      },
      {
        if: requiredObject("offset"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["list"] } } },
      },
      {
        if: requiredObject("limit"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["list", "history", "search"] } } },
      },
      {
        if: requiredObject("cursor"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["list", "history", "search"] } } },
      },
      {
        if: requiredObject("sort"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["list", "search"] } } },
      },
      { not: { anyOf: [requiredObject("cursor", "offset"), requiredObject("cursor", "before")] } },
      {
        if: { allOf: [{ properties: { action: { enum: ["search"] } } }, requiredObject("index")] },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: requiredObject("id"),
      },
      {
        if: { anyOf: [requiredObject("state"), requiredObject("text")] },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["list"] } } },
      },
      {
        if: requiredObject("query"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["search"] } } },
      },
      {
        if: requiredObject("before"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["history"] } } },
      },
      {
        if: { properties: { action: { enum: ["list"] } } },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { sort: { enum: ["attention", "newest", "oldest"] } } },
      },
      {
        if: { properties: { action: { enum: ["search"] } } },
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { sort: { enum: ["relevance", "newest"] } } },
      },
      {
        if: requiredObject("decision"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["review"] } } },
      },
      {
        if: requiredObject("full"),
        // JSON Schema's non-callable consequence keyword is not a Promise method.
        // oxlint-disable-next-line unicorn/no-thenable
        then: { properties: { action: { enum: ["inspect"] } } },
      },
    ],
  },
);

export const AgentRunsParams = Type.Object(
  { ...AgentRunsValidationParams.properties, acceptance: Type.Optional(DelegateAcceptance) },
  { additionalProperties: false },
);
