import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "../agent/typebox.ts";
export const intercomSchema = Type.Object({
  action: StringEnum(["list", "send", "ask", "reply", "pending", "status", "last"] as const, {
    description:
      "List, send, ask, reply, pending asks, connection status, or last completed assistant response.",
  }),
  scope: Type.Optional(
    StringEnum(["project", "all"] as const, {
      description:
        "For list/status: 'all' (default) includes every reachable session; 'project' further filters this repository and its worktrees.",
    }),
  ),
  to: Type.Optional(
    Type.String({
      description: "Target session name or ID (for 'send', 'ask', or disambiguating 'reply')",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Message for send/ask/reply",
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
  entryId: Type.Optional(Type.String({ description: "Last response entry ID for stable paging." })),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "Last response character offset (UTF-16)." }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 16384,
      description: "Last response page size; default/max 16384 characters.",
    }),
  ),
  passive: Type.Optional(
    Type.Boolean({
      description:
        "For action='send' only: legacy alias for delivery='passive'. Discouraged for agent-to-agent messages.",
    }),
  ),
});
