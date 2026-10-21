import type { Static } from "typebox";
import { Type } from "./typebox.ts";

export const thinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export const launchSchema = Type.Object({
  version: Type.Literal(1),
  id: Type.String(),
  rootId: Type.String(),
  predecessor: Type.Optional(Type.String()),
  owner: Type.String(),
  cwd: Type.String(),
  agentDir: Type.String(),
  sdk: Type.String(),
  entry: Type.String(),
  sessionFile: Type.String(),
  sessionId: Type.String(),
  prompt: Type.String(),
  context: Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
  provider: Type.String(),
  model: Type.String(),
  thinking: thinkingSchema,
  trusted: Type.Boolean(),
  name: Type.Optional(Type.String()),
  createdAt: Type.Number(),
});
export type Launch = Static<typeof launchSchema>;
export const processSchema = Type.Object({
  pid: Type.Integer({ minimum: 1 }),
  identity: Type.String(),
  token: Type.String(),
});
export type ProcessIdentity = Static<typeof processSchema>;
export const attachmentSchema = Type.Object({
  pid: Type.Integer({ minimum: 1 }),
  identity: Type.String(),
  generation: Type.String(),
  attached: Type.Boolean(),
});
export type Attachment = Static<typeof attachmentSchema>;
export const usageSchema = Type.Object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  totalTokens: Type.Number({ minimum: 0 }),
  reasoning: Type.Optional(Type.Number({ minimum: 0 })),
  cacheWrite1h: Type.Optional(Type.Number({ minimum: 0 })),
  cost: Type.Object({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    total: Type.Number({ minimum: 0 }),
  }),
});
export const contributionsSchema = Type.Array(
  Type.Object({
    id: Type.String({ minLength: 1 }),
    provider: Type.String(),
    model: Type.String(),
    usage: usageSchema,
  }),
);
export type Contribution = Static<typeof contributionsSchema>[number];
export const resultSchema = Type.Object({
  id: Type.String(),
  owner: Type.String(),
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("stopped")]),
  endedAt: Type.Number(),
  terminalEntryId: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  contributions: Type.Optional(contributionsSchema),
  accountingError: Type.Optional(Type.String()),
  accountingPending: Type.Optional(
    Type.Object({
      terminalCandidate: Type.String(),
      baseline: Type.Array(Type.String()),
    }),
  ),
});
export type Result = Static<typeof resultSchema>;
export const commandSchema = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  action: Type.Union([Type.Literal("run"), Type.Literal("steer"), Type.Literal("stop")]),
  prompt: Type.Optional(Type.String()),
  actorToken: Type.Optional(Type.String()),
  createdAt: Type.Number(),
});
export type Command = Static<typeof commandSchema>;
export const successorSchema = Type.Object({ id: Type.String() });
export const exitSchema = Type.Object({
  pid: Type.Integer(),
  code: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  at: Type.Number(),
});
export const admissionSchema = Type.Object({
  id: Type.String(),
  action: Type.String(),
  runId: Type.Optional(Type.String()),
  state: Type.Optional(Type.Union([Type.Literal("accepted"), Type.Literal("stale")])),
  at: Type.Number(),
});
export const delegateSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Provider/model ID; optional :thinking requires native model-reference support (case-insensitive, never fuzzy). No fallback.",
      }),
    ),
    context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
    async: Type.Optional(Type.Boolean({ default: true })),
  },
  { additionalProperties: false },
);
export type DelegateInput = Static<typeof delegateSchema>;
export const runsSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("inspect"),
      Type.Literal("continue"),
      Type.Literal("stop"),
      Type.Literal("wait"),
    ]),
    id: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    async: Type.Optional(Type.Boolean({ default: true })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    length: Type.Optional(Type.Integer({ minimum: 4, maximum: 262144 })),
  },
  { additionalProperties: false },
);
export type RunsInput = Static<typeof runsSchema>;
