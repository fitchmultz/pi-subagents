import { Compile, Type } from "../shared/native-typebox.ts";
import type { SubagentControlMessageDetails } from "./control-notices.ts";

const optionalString = Type.Optional(Type.String());
const optionalNumber = Type.Optional(Type.Number());
const attention = Type.Enum(["needs_attention"] as const, { type: "string" });
const notice = Compile(
  Type.Object(
    {
      event: Type.Object(
        {
          type: attention,
          from: Type.Optional(attention),
          to: attention,
          ts: Type.Number(),
          agent: Type.String(),
          runId: Type.String(),
          message: Type.String(),
          index: optionalNumber,
          reason: Type.Optional(
            Type.Enum(["idle", "completion_guard", "tool_failures"] as const, { type: "string" }),
          ),
          turns: optionalNumber,
          tokens: optionalNumber,
          toolCount: optionalNumber,
          currentTool: optionalString,
          currentToolDurationMs: optionalNumber,
          currentPath: optionalString,
          elapsedMs: optionalNumber,
          recentFailureSummary: optionalString,
          supervisorQuestion: Type.Optional(
            Type.Object(
              {
                questionId: Type.String(),
                state: Type.Enum(["awaiting_input", "answer_pending"] as const, { type: "string" }),
                answer: optionalString,
              },
              { additionalProperties: true },
            ),
          ),
        },
        { additionalProperties: true },
      ),
      source: Type.Optional(Type.Enum(["foreground", "async"] as const, { type: "string" })),
      asyncDir: optionalString,
      childIntercomTarget: optionalString,
      noticeText: optionalString,
    },
    { additionalProperties: true },
  ),
);

export function parseControlNotice(value: unknown): SubagentControlMessageDetails | undefined {
  return notice.Check(value) ? value : undefined;
}
