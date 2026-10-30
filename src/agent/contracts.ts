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
  clock: Type.Optional(
    Type.Object({
      boot: Type.String(),
      namespace: Type.String(),
      at: Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 20 }),
    }),
  ),
});
export type ProcessIdentity = Static<typeof processSchema>;
export const attachmentSchema = Type.Object({
  ...Type.Pick(processSchema, ["pid", "identity", "clock"]).properties,
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
/** Authority to restore exact working state, valid only after the named actor has exited. */
/** Exact parked authority: one exited generation's state bytes for this session and leaf. */
export const parkedSchema = Type.Object({
  token: Type.String(),
  state: Type.String(),
  digest: Type.String(),
  sessionId: Type.String(),
  leafId: Type.Union([Type.String(), Type.Null()]),
});
export type Parked = Static<typeof parkedSchema>;
export const wakeFailureSchema = Type.Object({
  at: Type.Number(),
  reason: Type.String(),
  beforeOpen: Type.Optional(
    Type.Object({
      actorToken: Type.String(),
      parkedToken: Type.String(),
    }),
  ),
});
export const readySchema = Type.Object({ token: Type.String() });
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
