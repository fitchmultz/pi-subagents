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
export const delegationContractSchema = Type.Object({
  scope: Type.Array(Type.String({ minLength: 1 })),
  verification: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  baseBranch: Type.Optional(Type.String({ minLength: 1 })),
  requiredPrimitives: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  nonGoals: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
export type DelegationContract = Static<typeof delegationContractSchema>;
export const overseerLaunchSchema = Type.Object({
  enabled: Type.Literal(true),
  judge: Type.Optional(Type.String({ minLength: 1 })),
});
export type OverseerLaunch = Static<typeof overseerLaunchSchema>;
export const escalationKindSchema = Type.Union([
  Type.Literal("scope_violation"),
  Type.Literal("branch_violation"),
  Type.Literal("primitive_violation"),
  Type.Literal("loop_violation"),
]);
export const escalationSchema = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  owner: Type.String(),
  at: Type.Number(),
  /** The number of this pause in the run. Named for what earlier versions took it to mean. */
  strikes: Type.Integer({ minimum: 1 }),
  kind: escalationKindSchema,
  summary: Type.String(),
  changedFiles: Type.Array(Type.String()),
  diffExcerpt: Type.String(),
  diffDigest: Type.String(),
  // A parent and a running child can be on different package versions: a child from before
  // these fields existed writes none of them.
  /** Where `changedFiles`, `stat` and `diffExcerpt` are measured from. */
  since: Type.Optional(Type.Union([Type.Literal("launch"), Type.Literal("approval")])),
  /** The changes since `since`, one `added<TAB>removed<TAB>file` line per file as `git diff --numstat` counts them. Files are spelled as in `changedFiles`. */
  stat: Type.Optional(Type.String()),
  /** Prints the whole diff when `diffExcerpt` is cut. */
  diffCommand: Type.Optional(Type.String()),
  /** Files changed since the last state that passed the checks, when that is later than `since`. */
  unchecked: Type.Optional(Type.Array(Type.String())),
  /** Files with work that `stat` and `diffExcerpt` do not show: committed on history that HEAD left, or dropped by a checkout. */
  leftBehind: Type.Optional(Type.Array(Type.String())),
  /** Files changed earlier in the run that the overseer approved. */
  approved: Type.Optional(Type.Array(Type.String())),
  /** How many earlier pauses of the run the overseer answered with a correction. */
  corrections: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type Escalation = Static<typeof escalationSchema>;
export const escalationResolutionSchema = Type.Object({
  escalationId: Type.String(),
  verdict: Type.Union([Type.Literal("steered"), Type.Literal("approved"), Type.Literal("stopped")]),
  diffDigest: Type.Optional(Type.String()),
  at: Type.Number(),
});
export type EscalationResolution = Static<typeof escalationResolutionSchema>;
/**
 * Saved by a supervised child while no judge has answered for its latest work, and removed when
 * a judge answers for that work or the work is accepted. The child does not wait for an answer
 * to it.
 */
export const judgeUnavailableSchema = Type.Object({
  at: Type.Number(),
  summary: Type.String(),
});
export type JudgeUnavailable = Static<typeof judgeUnavailableSchema>;
export const overseerReviewSchema = Type.Object({
  runId: Type.String(),
  verdict: Type.Union([Type.Literal("approved"), Type.Literal("changes_requested")]),
  summary: Type.String({ minLength: 1 }),
  at: Type.Number(),
});
export type OverseerReview = Static<typeof overseerReviewSchema>;
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
  contract: Type.Optional(delegationContractSchema),
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
