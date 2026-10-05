import { Type } from "../shared/native-typebox.ts";

const AcceptanceEvidenceKind = Type.Enum(
  [
    "changed-files",
    "tests-added",
    "commands-run",
    "validation-output",
    "residual-risks",
    "no-staged-files",
    "diff-summary",
    "review-findings",
    "manual-notes",
  ] as const,
  { type: "string" },
);

const AcceptanceGateSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    must: Type.String({ minLength: 1 }),
    evidence: Type.Optional(Type.Array(AcceptanceEvidenceKind)),
    severity: Type.Optional(Type.Enum(["required", "recommended"] as const, { type: "string" })),
  },
  { additionalProperties: false },
);

const AcceptanceVerifyCommandSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    command: Type.String({ minLength: 1 }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    cwd: Type.Optional(Type.String()),
    env: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: { type: "string" } })),
    allowFailure: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AcceptanceOverride = Type.Unsafe({
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: { anyOf: [{ type: "string", minLength: 1 }, AcceptanceGateSchema] },
    },
    evidence: { type: "array", items: AcceptanceEvidenceKind },
    verify: { type: "array", items: AcceptanceVerifyCommandSchema },
    stopRules: { type: "array", items: { type: "string", minLength: 1 } },
    maxFinalizationTurns: { type: "integer", minimum: 1, maximum: 10 },
  },
  additionalProperties: false,
  description:
    "Optional acceptance contract. criteria=definition of done, evidence/verify=proof, stopRules=constraints, maxFinalizationTurns=self-review budget; at least one required. no-staged-files requires the entire Git index to be empty, including pre-existing staged paths. Continue/resume/answer overrides apply only to newly started continuations, never to a live child's acceptance. See the pi-subagents skill.",
});

// The everyday tools use closed acceptance shapes. Advanced callers retain the full contract.
export const DelegateAcceptance = Type.Object(
  {
    criteria: Type.Optional(Type.Array(AcceptanceGateSchema)),
    evidence: Type.Optional(Type.Array(AcceptanceEvidenceKind)),
    verify: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ...AcceptanceVerifyCommandSchema.properties,
            env: Type.Optional(
              Type.Array(
                Type.Object(
                  { name: Type.String({ minLength: 1 }), value: Type.String() },
                  { additionalProperties: false },
                ),
              ),
            ),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    stopRules: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    maxFinalizationTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  {
    additionalProperties: false,
    description:
      "Acceptance criteria, evidence, verification commands and stop rules. Criteria use objects; verification environment uses unique name/value pairs. Self-review budget: 1–10 turns.",
  },
);
