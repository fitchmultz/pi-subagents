import type { Static } from "typebox";
import { Type } from "./typebox.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const thinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export const overseerLaunchSchema = Type.Object({
  enabled: Type.Literal(true),
  judge: Type.Optional(Type.String({ minLength: 1 })),
});
export type OverseerLaunch = Static<typeof overseerLaunchSchema>;

export const overseerLiveStateSchema = Type.Object({
  version: Type.Literal(1),
  enabled: Type.Boolean(),
  judge: Type.String({ minLength: 1 }),
  updatedAt: Type.Number(),
});
export type OverseerLiveState = Static<typeof overseerLiveStateSchema>;

export const skepticFindingKindSchema = Type.Union([
  Type.Literal("intent_drift"),
  Type.Literal("invented_constraint"),
  Type.Literal("dropped_behavior"),
  Type.Literal("custom_plumbing"),
  Type.Literal("weakened_test"),
  Type.Literal("bug"),
]);
export type SkepticFindingKind = Static<typeof skepticFindingKindSchema>;

export const skepticFindingSchema = Type.Object({
  kind: skepticFindingKindSchema,
  file: Type.String({ minLength: 1 }),
  excerpt: Type.String({ minLength: 1 }),
  why: Type.String({ minLength: 1 }),
  blocking: Type.Boolean(),
});
export type SkepticFinding = Static<typeof skepticFindingSchema>;

export const checkpointKindSchema = Type.Union([
  Type.Literal("shape_check"),
  Type.Literal("skeptic"),
  Type.Literal("final_diff"),
  Type.Literal("tool_errors"),
]);
export type CheckpointKind = Static<typeof checkpointKindSchema>;

export const toolErrorTurnSchema = Type.Object({
  messageEntryId: Type.String(),
  tools: Type.Array(
    Type.Object({
      toolName: Type.String(),
      toolCallId: Type.String(),
      isError: Type.Boolean(),
      repeatedFrom: Type.Optional(Type.String()),
    }),
  ),
});
export type ToolErrorTurn = Static<typeof toolErrorTurnSchema>;

export const escalationSchema = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  owner: Type.String(),
  at: Type.Number(),
  pauseNumber: Type.Integer({ minimum: 1 }),
  kind: checkpointKindSchema,
  summary: Type.String(),
  model: Type.Optional(Type.String({ minLength: 1 })),
  findings: Type.Optional(Type.Array(skepticFindingSchema)),
  changedFiles: Type.Array(Type.String()),
  diffExcerpt: Type.String(),
  diffDigest: Type.String(),
  since: Type.Union([Type.Literal("launch"), Type.Literal("checkpoint")]),
  stat: Type.Optional(Type.String()),
  diffCommand: Type.Optional(Type.String()),
  steers: Type.Optional(Type.Integer({ minimum: 0 })),
  toolErrorTurns: Type.Optional(Type.Array(toolErrorTurnSchema)),
});
export type Escalation = Static<typeof escalationSchema>;

export const escalationResolutionSchema = Type.Object({
  escalationId: Type.String(),
  verdict: Type.Union([Type.Literal("approved"), Type.Literal("steered"), Type.Literal("stopped")]),
  diffDigest: Type.Optional(Type.String()),
  steer: Type.Optional(
    Type.Object({
      id: Type.String(),
      prompt: Type.String(),
    }),
  ),
  at: Type.Number(),
});
export type EscalationResolution = Static<typeof escalationResolutionSchema>;

/** Non-blocking grounded findings published while the child continues working. */
export const overseerNoteSchema = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  owner: Type.String(),
  at: Type.Number(),
  model: Type.String({ minLength: 1 }),
  findings: Type.Array(skepticFindingSchema, { minItems: 1 }),
});
export type OverseerNote = Static<typeof overseerNoteSchema>;

export const overseerNotesSchema = Type.Object({
  version: Type.Literal(1),
  notes: Type.Array(overseerNoteSchema),
});
export type OverseerNotes = Static<typeof overseerNotesSchema>;

export const judgeUnavailableSchema = Type.Object({
  at: Type.Number(),
  summary: Type.String(),
});
export type JudgeUnavailable = Static<typeof judgeUnavailableSchema>;

export const judgeFailureSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
});
export type JudgeFailure = Static<typeof judgeFailureSchema>;

const judgeCheckpointFields = {
  at: Type.Number(),
  judge: Type.String({ minLength: 1 }),
  failed: Type.Optional(Type.Array(judgeFailureSchema, { minItems: 1 })),
};

export const judgeCheckpointSchema = Type.Union([
  Type.Object({
    ...judgeCheckpointFields,
    outcome: Type.Union([Type.Literal("ok"), Type.Literal("flagged"), Type.Literal("notes")]),
    model: Type.String({ minLength: 1 }),
    blockingCount: Type.Integer({ minimum: 0 }),
    noteCount: Type.Integer({ minimum: 0 }),
    droppedUngrounded: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    ...judgeCheckpointFields,
    outcome: Type.Literal("unavailable"),
    error: Type.Optional(Type.String({ minLength: 1 })),
  }),
]);
export type JudgeCheckpoint = Static<typeof judgeCheckpointSchema>;

export const judgeCheckpointsSchema = Type.Object({
  version: Type.Literal(1),
  checkpoints: Type.Array(judgeCheckpointSchema, { minItems: 1 }),
});
export type JudgeCheckpoints = Static<typeof judgeCheckpointsSchema>;

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
  readOnly: Type.Optional(Type.Boolean()),
  ownerContext: Type.Optional(Type.String({ minLength: 1 })),
  overseer: Type.Optional(overseerLaunchSchema),
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
  changedFiles: Type.Optional(Type.Array(Type.String())),
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

export type AccountingState =
  | { readonly kind: "unrecorded"; readonly terminalEntryId: string | undefined }
  | {
      readonly kind: "verified";
      readonly contributions: Contribution[];
      readonly terminalEntryId: string | undefined;
    }
  | {
      readonly kind: "pending";
      readonly pending: NonNullable<Result["accountingPending"]>;
      readonly error: string | undefined;
    }
  | {
      readonly kind: "unavailable";
      readonly error: string;
      readonly terminalEntryId: string | undefined;
    };

export const commandMetadataSchema = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  action: Type.Union([Type.Literal("run"), Type.Literal("steer"), Type.Literal("stop")]),
  createdAt: Type.Number(),
});
const commandFields = Type.Omit(commandMetadataSchema, ["action"]).properties;
export const commandSchema = Type.Union([
  Type.Object({ ...commandFields, action: Type.Literal("run") }),
  Type.Object({ ...commandFields, action: Type.Literal("steer"), prompt: Type.String() }),
  Type.Object({
    ...commandFields,
    action: Type.Literal("stop"),
    // Historical unbound Stops parse but cannot target any current actor.
    actorToken: Type.Optional(Type.String()),
  }),
]);
export type Command = Static<typeof commandSchema>;

export const successorSchema = Type.Object({ id: Type.String() });

/** The unfinished background work an idle child session reported; its run stays open for it. */
export const waitingSchema = Type.Object({
  since: Type.Number(),
  work: Type.Array(Type.Object({ id: Type.String(), description: Type.String() })),
});
export type Waiting = Static<typeof waitingSchema>;

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
export type WakeFailure = Static<typeof wakeFailureSchema>;

export const readySchema = Type.Object({ token: Type.String() });
export const exitSchema = Type.Object({
  pid: Type.Integer(),
  code: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  at: Type.Number(),
});
export type Exit = Static<typeof exitSchema>;

export const admissionSchema = Type.Object({
  id: Type.String(),
  action: Type.String(),
  runId: Type.Optional(Type.String()),
  state: Type.Optional(Type.Union([Type.Literal("accepted"), Type.Literal("stale")])),
  at: Type.Number(),
});
