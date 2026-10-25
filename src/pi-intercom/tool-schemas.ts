import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "../agent/typebox.ts";
export const intercomSchema = Type.Object({
  action: StringEnum(["list", "send", "ask", "reply", "pending", "status", "last"] as const),
  scope: Type.Optional(
    StringEnum(["project", "all"] as const, {
      description: "all (default) or project (repo and worktrees)",
    }),
  ),
  to: Type.Optional(Type.String({ description: "Session name or ID" })),
  message: Type.Optional(Type.String()),
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        type: StringEnum(["file", "snippet", "context"] as const),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }),
    ),
  ),
  replyTo: Type.Optional(Type.String({ description: "Message ID to answer or thread" })),
  delivery: Type.Optional(
    StringEnum(["queue", "steer", "passive"] as const, {
      description:
        "steer (default) at next tool boundary; queue after active work; passive never wakes the model",
    }),
  ),
  queueMode: Type.Optional(
    StringEnum(["stack", "replace"] as const, {
      description: "stack keeps all; replace keeps only the latest per threadId",
    }),
  ),
  threadId: Type.Optional(Type.String()),
  entryId: Type.Optional(Type.String()),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-16 characters" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })),
  passive: Type.Optional(Type.Boolean({ description: "Legacy alias for delivery=passive" })),
});
