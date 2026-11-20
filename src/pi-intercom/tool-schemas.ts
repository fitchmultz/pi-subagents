import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "../agent/typebox.ts";
import { runContractSchema } from "../agent/tool-schemas.ts";

const intercomContractSchema = Type.Object(runContractSchema.properties, {
  additionalProperties: false,
  description:
    'Optional delegation contract amendment for action="reply" when answering an owned child run. Validated and persisted before the reply wakes the child; rejected for other actions or non-owned senders.',
});

export const intercomSchema = Type.Object(
  {
    action: StringEnum([
      "list",
      "send",
      "ask",
      "reply",
      "pending",
      "status",
      "last",
      "claim",
    ] as const),
    scope: Type.Optional(
      StringEnum(["project", "all"] as const, {
        description: "all (default) or project (repo and worktrees)",
      }),
    ),
    children: Type.Optional(
      Type.Boolean({ description: "list: print child rows instead of a count" }),
    ),
    device: Type.Optional(
      Type.String({ description: "list: mains on another device (alias) or all" }),
    ),
    to: Type.Optional(Type.String({ description: "Session name or ID" })),
    message: Type.Optional(
      Type.String({
        description: "Text for send/ask/reply, or 1-line workingOn note for claim (empty clears)",
      }),
    ),
    attachments: Type.Optional(
      Type.Array(
        Type.Object(
          {
            type: StringEnum(["file", "snippet", "context"] as const),
            name: Type.String(),
            content: Type.String(),
            language: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    replyTo: Type.Optional(Type.String({ description: "Message ID to answer or thread" })),
    contract: Type.Optional(intercomContractSchema),
    entryId: Type.Optional(Type.String()),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-16 characters" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })),
  },
  { additionalProperties: false },
);
