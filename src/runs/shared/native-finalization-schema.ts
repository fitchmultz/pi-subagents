import { Type, Compile } from "../../shared/native-typebox.ts";
import type {
  NativeFinalizationConfig,
  NativeFinalizationEvent,
} from "./native-finalization-types.ts";

const string = Type.String();
const number = Type.Number();
const strings = Type.Array(string);
const optionalString = Type.Optional(string);
const optionalNumber = Type.Optional(number);
const bool = Type.Boolean();
const optionalBoolean = Type.Optional(bool);
const unknownRecord = Type.Record(string, Type.Unknown());
const evidence = Type.Union([
  Type.Literal("changed-files"),
  Type.Literal("tests-added"),
  Type.Literal("commands-run"),
  Type.Literal("validation-output"),
  Type.Literal("residual-risks"),
  Type.Literal("no-staged-files"),
  Type.Literal("diff-summary"),
  Type.Literal("review-findings"),
  Type.Literal("manual-notes"),
]);
const criteria = Type.Array(
  Type.Object({
    id: string,
    must: string,
    evidence: Type.Array(evidence),
    severity: Type.Union([Type.Literal("required"), Type.Literal("recommended")]),
  }),
);
const level = Type.Union([
  Type.Literal("none"),
  Type.Literal("attested"),
  Type.Literal("checked"),
  Type.Literal("verified"),
]);
const status = Type.Union([
  Type.Literal("not-required"),
  Type.Literal("claimed"),
  Type.Literal("attested"),
  Type.Literal("checked"),
  Type.Literal("verified"),
  Type.Literal("accepted"),
  Type.Literal("blocked"),
  Type.Literal("rejected"),
]);
const report = Type.Object({
  criteriaSatisfied: Type.Optional(
    Type.Array(
      Type.Object({
        id: optionalString,
        status: Type.Union([
          Type.Literal("satisfied"),
          Type.Literal("not-satisfied"),
          Type.Literal("not-applicable"),
          Type.Literal("blocked"),
        ]),
        evidence: string,
        humanAction: optionalString,
      }),
    ),
  ),
  changedFiles: Type.Optional(strings),
  testsAddedOrUpdated: Type.Optional(strings),
  commandsRun: Type.Optional(
    Type.Array(
      Type.Object({
        command: string,
        result: Type.Union([
          Type.Literal("passed"),
          Type.Literal("failed"),
          Type.Literal("not-run"),
        ]),
        summary: string,
      }),
    ),
  ),
  validationOutput: Type.Optional(strings),
  residualRisks: Type.Optional(strings),
  noStagedFiles: optionalBoolean,
  diffSummary: optionalString,
  reviewFindings: Type.Optional(Type.Array(Type.Union([string, unknownRecord]))),
  manualNotes: optionalString,
  notes: optionalString,
});
const acceptance = Type.Object({
  level,
  explicit: bool,
  inferredReason: strings,
  criteria,
  evidence: Type.Array(evidence),
  verify: Type.Array(
    Type.Object({
      id: string,
      command: string,
      timeoutMs: optionalNumber,
      cwd: optionalString,
      env: Type.Optional(Type.Record(string, string)),
      allowFailure: optionalBoolean,
    }),
  ),
  stopRules: strings,
  finalization: Type.Object({
    mode: Type.Union([Type.Literal("none"), Type.Literal("self-review-loop")]),
    maxTurns: number,
  }),
});
const runtimeChecks = Type.Array(
  Type.Object({
    id: string,
    status: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("blocked"),
      Type.Literal("not-applicable"),
    ]),
    message: string,
  }),
);
const verifyRuns = Type.Array(
  Type.Object({
    id: string,
    command: string,
    cwd: optionalString,
    exitCode: Type.Union([number, Type.Null()]),
    status: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("timed-out"),
      Type.Literal("allowed-failure"),
    ]),
    stdout: optionalString,
    stderr: optionalString,
    durationMs: number,
  }),
);
const ledger = Type.Object({
  status,
  explicit: bool,
  effectiveAcceptance: acceptance,
  inferredReason: strings,
  criteria,
  childReport: Type.Optional(report),
  childReportParseError: optionalString,
  initialChildReport: Type.Optional(report),
  initialChildReportParseError: optionalString,
  unconfirmedOutput: optionalString,
  runtimeChecks,
  verifyRuns,
  finalization: Type.Optional(
    Type.Object({
      mode: Type.Literal("self-review-loop"),
      status: Type.Union([
        Type.Literal("not-run"),
        Type.Literal("completed"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ]),
      maxTurns: number,
      turns: Type.Array(
        Type.Object({
          turn: number,
          prompt: string,
          status,
          rawOutput: optionalString,
          unconfirmedOutput: optionalString,
          report: Type.Optional(report),
          parseError: optionalString,
          runtimeChecks,
          verifyRuns,
          failureMessage: optionalString,
        }),
      ),
    }),
  ),
});
const snapshot = Type.Object({
  exists: bool,
  mtimeMs: optionalNumber,
  ctimeMs: optionalNumber,
  size: optionalNumber,
  ino: optionalNumber,
});
const runtime = Type.Object({
  schema: unknownRecord,
  schemaPath: string,
  outputPath: string,
  publicOutputSchema: Type.Optional(unknownRecord),
});
const configValidator = Compile(
  Type.Object({
    nonce: string,
    acceptance,
    reportRuntime: runtime,
    publicOutput: Type.Optional(runtime),
    outputPath: optionalString,
    outputSnapshot: Type.Optional(snapshot),
  }),
);
const eventValidator = Compile(
  Type.Object({
    type: Type.Literal("subagent.finalization"),
    nonce: string,
    turn: number,
    lastEntryId: optionalString,
    messageCount: number,
    at: number,
    submission: Type.Object({
      output: string,
      structuredOutput: Type.Optional(Type.Unknown()),
      report: Type.Optional(report),
      reportParseError: optionalString,
      reportSubmissionError: optionalString,
      unconfirmedOutput: optionalString,
      error: optionalString,
    }),
    acceptance: Type.Optional(ledger),
    resolvedOutput: Type.Object({
      fullOutput: string,
      savedPath: optionalString,
      saveError: optionalString,
      writtenSnapshot: Type.Optional(snapshot),
    }),
    nextPrompt: optionalString,
  }),
);

/** Validate the complete persisted lifecycle contract without claiming SDK message completeness. */
export function parseNativeFinalizationConfig(value: unknown): NativeFinalizationConfig {
  if (!configValidator.Check(value)) {
    throw new SyntaxError("Invalid native finalization configuration");
  }
  return value;
}
export function parseNativeFinalizationEvent(value: unknown): NativeFinalizationEvent {
  if (!eventValidator.Check(value)) {
    throw new SyntaxError("Invalid native finalization boundary");
  }
  return value;
}
