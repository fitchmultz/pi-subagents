import {
  arr,
  bool,
  int,
  lit,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";
import { stringEnum } from "../shared/schema.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const thinkingSchema = oneOf(THINKING_LEVELS);

export const overseerLaunchSchema = obj(
  {
    enabled: lit(true),
    judge: opt(str({ minLength: 1 })),
  },
  { open: true },
);
export type OverseerLaunch = Static<typeof overseerLaunchSchema>;

export const overseerLiveStateSchema = obj(
  {
    version: lit(1),
    enabled: bool(),
    judge: str({ minLength: 1 }),
    updatedAt: num(),
  },
  { open: true },
);
export type OverseerLiveState = Static<typeof overseerLiveStateSchema>;

export const skepticFindingKindSchema = stringEnum([
  "intent_drift",
  "invented_constraint",
  "dropped_behavior",
  "custom_plumbing",
  "weakened_test",
  "bug",
]);
export type SkepticFindingKind = Static<typeof skepticFindingKindSchema>;

export const skepticFindingSchema = obj(
  {
    kind: skepticFindingKindSchema,
    file: str({ minLength: 1 }),
    excerpt: str({ minLength: 1 }),
    why: str({ minLength: 1 }),
    blocking: bool(),
  },
  { open: true },
);
export type SkepticFinding = Static<typeof skepticFindingSchema>;

export const checkpointKindSchema = oneOf(["shape_check", "skeptic", "final_diff", "tool_errors"]);
export type CheckpointKind = Static<typeof checkpointKindSchema>;

export const toolErrorTurnSchema = obj(
  {
    messageEntryId: str(),
    tools: arr(
      obj(
        {
          toolName: str(),
          toolCallId: str(),
          isError: bool(),
          repeatedFrom: opt(str()),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
export type ToolErrorTurn = Static<typeof toolErrorTurnSchema>;

export const escalationSchema = obj(
  {
    id: str(),
    runId: str(),
    owner: str(),
    at: num(),
    pauseNumber: int({ minimum: 1 }),
    kind: checkpointKindSchema,
    summary: str(),
    model: opt(str({ minLength: 1 })),
    findings: opt(arr(skepticFindingSchema)),
    changedFiles: arr(str()),
    diffExcerpt: str(),
    diffDigest: str(),
    since: oneOf(["launch", "checkpoint"]),
    stat: opt(str()),
    diffCommand: opt(str()),
    steers: opt(int({ minimum: 0 })),
    toolErrorTurns: opt(arr(toolErrorTurnSchema)),
  },
  { open: true },
);
export type Escalation = Static<typeof escalationSchema>;

export const escalationResolutionSchema = obj(
  {
    escalationId: str(),
    verdict: oneOf(["approved", "steered", "stopped"]),
    diffDigest: opt(str()),
    steer: opt(
      obj(
        {
          id: str(),
          prompt: str(),
        },
        { open: true },
      ),
    ),
    at: num(),
  },
  { open: true },
);
export type EscalationResolution = Static<typeof escalationResolutionSchema>;

/** Non-blocking grounded findings published while the child continues working. */
export const overseerNoteSchema = obj(
  {
    id: str(),
    runId: str(),
    owner: str(),
    at: num(),
    model: str({ minLength: 1 }),
    findings: arr(skepticFindingSchema, { minItems: 1 }),
  },
  { open: true },
);
export type OverseerNote = Static<typeof overseerNoteSchema>;

export const overseerNotesSchema = obj(
  {
    version: lit(1),
    notes: arr(overseerNoteSchema),
  },
  { open: true },
);
export type OverseerNotes = Static<typeof overseerNotesSchema>;

export const judgeUnavailableSchema = obj(
  {
    at: num(),
    summary: str(),
  },
  { open: true },
);
export type JudgeUnavailable = Static<typeof judgeUnavailableSchema>;

export const judgeFailureSchema = obj(
  {
    model: str({ minLength: 1 }),
    reason: str({ minLength: 1 }),
  },
  { open: true },
);
export type JudgeFailure = Static<typeof judgeFailureSchema>;

const judgeCheckpointFields = {
  at: num(),
  judge: str({ minLength: 1 }),
  failed: opt(arr(judgeFailureSchema, { minItems: 1 })),
};

export const judgeCheckpointSchema = union([
  obj(
    {
      ...judgeCheckpointFields,
      outcome: oneOf(["ok", "flagged", "notes"]),
      model: str({ minLength: 1 }),
      blockingCount: int({ minimum: 0 }),
      noteCount: int({ minimum: 0 }),
      droppedUngrounded: int({ minimum: 0 }),
    },
    { open: true },
  ),
  obj(
    {
      ...judgeCheckpointFields,
      outcome: lit("unavailable"),
      error: opt(str({ minLength: 1 })),
    },
    { open: true },
  ),
]);
export type JudgeCheckpoint = Static<typeof judgeCheckpointSchema>;

export const judgeCheckpointsSchema = obj(
  {
    version: lit(1),
    checkpoints: arr(judgeCheckpointSchema, { minItems: 1 }),
  },
  { open: true },
);
export type JudgeCheckpoints = Static<typeof judgeCheckpointsSchema>;

export const launchSchema = obj(
  {
    version: lit(1),
    id: str(),
    rootId: str(),
    predecessor: opt(str()),
    owner: str(),
    cwd: str(),
    agentDir: str(),
    sdk: str(),
    entry: str(),
    sessionFile: str(),
    sessionId: str(),
    prompt: str(),
    context: oneOf(["fresh", "fork"]),
    provider: str(),
    model: str(),
    thinking: thinkingSchema,
    trusted: bool(),
    name: opt(str()),
    readOnly: opt(bool()),
    ownerContext: opt(str({ minLength: 1 })),
    overseer: opt(overseerLaunchSchema),
    createdAt: num(),
  },
  { open: true },
);
export type Launch = Static<typeof launchSchema>;

const processIdentityFields = {
  pid: int({ minimum: 1 }),
  identity: str(),
  clock: opt(
    obj(
      {
        boot: str(),
        namespace: str(),
        at: str({ pattern: "^[1-9][0-9]*$", maxLength: 20 }),
      },
      { open: true },
    ),
  ),
};

export const processSchema = obj(
  {
    ...processIdentityFields,
    token: str(),
  },
  { open: true },
);
export type ProcessIdentity = Static<typeof processSchema>;

export const attachmentSchema = obj(
  {
    ...processIdentityFields,
    generation: str(),
    attached: bool(),
  },
  { open: true },
);
export type Attachment = Static<typeof attachmentSchema>;

export const usageSchema = obj(
  {
    input: num({ minimum: 0 }),
    output: num({ minimum: 0 }),
    cacheRead: num({ minimum: 0 }),
    cacheWrite: num({ minimum: 0 }),
    totalTokens: num({ minimum: 0 }),
    reasoning: opt(num({ minimum: 0 })),
    cacheWrite1h: opt(num({ minimum: 0 })),
    cost: obj(
      {
        input: num({ minimum: 0 }),
        output: num({ minimum: 0 }),
        cacheRead: num({ minimum: 0 }),
        cacheWrite: num({ minimum: 0 }),
        total: num({ minimum: 0 }),
      },
      { open: true },
    ),
  },
  { open: true },
);

export const contributionsSchema = arr(
  obj(
    {
      id: str({ minLength: 1 }),
      provider: str(),
      model: str(),
      usage: usageSchema,
    },
    { open: true },
  ),
);
export type Contribution = Static<typeof contributionsSchema>[number];

export const resultSchema = obj(
  {
    id: str(),
    owner: str(),
    status: oneOf(["completed", "failed", "stopped"]),
    endedAt: num(),
    terminalEntryId: opt(str()),
    error: opt(str()),
    changedFiles: opt(arr(str())),
    contributions: opt(contributionsSchema),
    accountingError: opt(str()),
    accountingPending: opt(
      obj(
        {
          terminalCandidate: str(),
          baseline: arr(str()),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
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

const commandBaseFields = {
  id: str(),
  runId: str(),
  createdAt: num(),
};

const commandMetadataProperties = {
  ...commandBaseFields,
  action: oneOf(["run", "steer", "stop"]),
};
export const COMMAND_METADATA_KEYS: ReadonlySet<string> = new Set(
  Object.keys(commandMetadataProperties),
);
export const commandMetadataSchema = obj(commandMetadataProperties, { open: true });

export const commandSchema = union([
  obj({ ...commandBaseFields, action: lit("run") }, { open: true }),
  obj({ ...commandBaseFields, action: lit("steer"), prompt: str() }, { open: true }),
  obj(
    {
      ...commandBaseFields,
      action: lit("stop"),
      // Historical unbound Stops parse but cannot target any current actor.
      actorToken: opt(str()),
    },
    { open: true },
  ),
]);
export type Command = Static<typeof commandSchema>;

export const successorSchema = obj({ id: str() }, { open: true });

/** The unfinished background work an idle child session reported; its run stays open for it. */
export const waitingSchema = obj(
  {
    since: num(),
    work: arr(obj({ id: str(), description: str() }, { open: true })),
  },
  { open: true },
);
export type Waiting = Static<typeof waitingSchema>;

/** Exact parked authority: one exited generation's state bytes for this session and leaf. */
export const parkedSchema = obj(
  {
    token: str(),
    state: str(),
    digest: str(),
    sessionId: str(),
    leafId: nullable(str()),
  },
  { open: true },
);
export type Parked = Static<typeof parkedSchema>;

export const wakeFailureSchema = obj(
  {
    at: num(),
    reason: str(),
    beforeOpen: opt(
      obj(
        {
          actorToken: str(),
          parkedToken: str(),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
export type WakeFailure = Static<typeof wakeFailureSchema>;

export const readySchema = obj({ token: str() }, { open: true });
export const exitSchema = obj(
  {
    pid: int(),
    code: nullable(int()),
    signal: nullable(str()),
    at: num(),
  },
  { open: true },
);
export type Exit = Static<typeof exitSchema>;

export const admissionSchema = obj(
  {
    id: str(),
    action: str(),
    runId: opt(str()),
    state: opt(oneOf(["accepted", "stale"])),
    at: num(),
  },
  { open: true },
);
