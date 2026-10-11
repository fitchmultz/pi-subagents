import { Compile, Type } from "../shared/native-typebox.ts";

const policy = Type.Enum(["inherit", "approve", "no-approve"] as const, { type: "string" });
const optionalNumber = Type.Optional(Type.Number());
const optionalBoolean = Type.Optional(Type.Boolean());
const optionalString = Type.Optional(Type.String());

export const extensionConfig = Compile(
  Type.Object(
    {
      compactChildTools: optionalBoolean,
      asyncByDefault: optionalBoolean,
      forceTopLevelAsync: optionalBoolean,
      defaultSessionDir: optionalString,
      maxSubagentDepth: optionalNumber,
      worktreeSetupHook: optionalString,
      worktreeSetupHookTimeoutMs: optionalNumber,
      projectTrust: Type.Optional(
        Type.Union([
          policy,
          Type.Object({ childRuns: Type.Optional(policy) }, { additionalProperties: true }),
        ]),
      ),
      parallel: Type.Optional(
        Type.Object(
          { maxTasks: optionalNumber, concurrency: optionalNumber },
          { additionalProperties: true },
        ),
      ),
      chain: Type.Optional(
        Type.Object(
          {
            dynamicFanout: Type.Optional(
              Type.Object({ maxItems: optionalNumber }, { additionalProperties: true }),
            ),
          },
          { additionalProperties: true },
        ),
      ),
      control: Type.Optional(
        Type.Object(
          {
            enabled: optionalBoolean,
            needsAttentionAfterMs: optionalNumber,
            failedToolAttemptsBeforeAttention: optionalNumber,
            notifyOn: Type.Optional(
              Type.Array(Type.Enum(["needs_attention"] as const, { type: "string" })),
            ),
            notifyChannels: Type.Optional(
              Type.Array(Type.Enum(["event", "async", "intercom"] as const, { type: "string" })),
            ),
          },
          { additionalProperties: true },
        ),
      ),
    },
    { additionalProperties: true },
  ),
);
