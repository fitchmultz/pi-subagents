import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "../shared/native-typebox.ts";
export const contactSupervisorSchema = Type.Object({
  reason: StringEnum(["need_decision", "progress_update", "interview_request"] as const, {
    description:
      "Contact reason: 'need_decision' and 'interview_request' steer the supervisor and wait for a reply; 'progress_update' steers a material discovery without waiting for a reply",
  }),
  message: Type.Optional(
    Type.String({
      description:
        "Decision request, optional interview note, or meaningful progress update for the supervisor",
    }),
  ),
  interview: Type.Optional(
    Type.Object(
      {
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        questions: Type.Array(
          Type.Object({
            id: Type.String(),
            type: StringEnum(["single", "multi", "text", "image", "info"] as const, {
              description: "Question type: single, multi, text, image, or info",
            }),
            question: Type.String(),
            options: Type.Optional(Type.Array(Type.Unknown())),
            context: Type.Optional(Type.String()),
          }),
        ),
      },
      { description: "Structured interview request for reason='interview_request'" },
    ),
  ),
});
export const intercomSchema = Type.Object({
  action: StringEnum(
    [
      "list",
      "send",
      "ask",
      "reply",
      "pending",
      "status",
      "subscribe",
      "unsubscribe",
      "publish",
      "topics",
    ] as const,
    {
      description:
        "Direct messages: list/send/ask/reply/pending/status. Quiet state: subscribe/unsubscribe/publish/topics.",
    },
  ),
  scope: Type.Optional(
    StringEnum(["project", "all"] as const, {
      description:
        "For list/status: 'project' (default) shows this Git repository and its worktrees; 'all' includes sessions in other projects.",
    }),
  ),
  to: Type.Optional(
    Type.String({
      description: "Target session name or ID (for 'send', 'ask', or disambiguating 'reply')",
    }),
  ),
  topic: Type.Optional(
    Type.String({
      description:
        "Exact opt-in topic for subscribe/unsubscribe/publish/topics; no automatic subscriptions.",
    }),
  ),
  event: Type.Optional(
    StringEnum(["update", "blocker", "decision", "release"] as const, {
      description:
        "Publish: update is quiet current state. Blockers/decisions interrupt subscribers; release interrupts only those awaiting release.",
    }),
  ),
  resource: Type.Optional(
    Type.String({
      description: "Publish: resource this session is using (advisory ownership, not a lock).",
    }),
  ),
  ownership: Type.Optional(
    StringEnum(["held", "released"] as const, {
      description:
        "Publish: this session's declared resource state. Disconnect never implies released.",
    }),
  ),
  awaitRelease: Type.Optional(
    Type.Boolean({
      description: "Subscribe: interrupt when this topic explicitly releases ownership.",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Message for send/ask/reply, or self-contained latest state for publish",
    }),
  ),
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
  replyTo: Type.Optional(
    Type.String({
      description: "Message ID to reply to (for threading or responding to an 'ask')",
    }),
  ),
  delivery: Type.Optional(
    StringEnum(["queue", "steer", "passive"] as const, {
      description:
        "Delivery mode. Omitted send delivery defaults to 'steer', which injects after the current tool call. Use 'queue' only to intentionally wait behind active work; 'passive' does not wake the recipient model.",
    }),
  ),
  queueMode: Type.Optional(
    StringEnum(["stack", "replace"] as const, {
      description:
        "For delivery='queue': 'stack' keeps all messages; 'replace' keeps only the latest undelivered message for the same threadId.",
    }),
  ),
  threadId: Type.Optional(
    Type.String({ description: "Stable topic key for queueMode='replace'." }),
  ),
  passive: Type.Optional(
    Type.Boolean({
      description:
        "For action='send' only: legacy alias for delivery='passive'. Discouraged for agent-to-agent messages.",
    }),
  ),
});
