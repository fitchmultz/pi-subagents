import { Type, Check } from "../shared/native-typebox.ts";
import type { AgentVisit } from "./view-model.ts";
const quote = Type.Object({ title: Type.String(), text: Type.String() });
const anchor = Type.Object({ id: Type.String(), line: Type.Number() });
const outgoing = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  index: Type.Number(),
  text: Type.String(),
  draft: Type.String(),
  quote: Type.Optional(quote),
  at: Type.Number(),
  status: Type.Union([
    Type.Literal("sending"),
    Type.Literal("waiting"),
    Type.Literal("unconfirmed"),
  ]),
  reason: Type.Optional(Type.String()),
});
const visit = Type.Object({
  draft: Type.String(),
  quote: Type.Optional(quote),
  anchor: Type.Optional(anchor),
  readThrough: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  seenActivityAt: Type.Optional(Type.Number()),
  outbox: Type.Array(outgoing),
  lastSentId: Type.Optional(Type.String()),
  notice: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Object({ continue: Type.Union([Type.Literal("finished"), Type.Literal("blocked")]) }),
    ]),
  ),
});
const saved = Type.Object({
  ownerSessionId: Type.String(),
  visits: Type.Array(Type.Tuple([Type.String(), visit])),
  pinned: Type.Optional(Type.String()),
});
export function restoredView(
  value: unknown,
  ownerSessionId: string,
): { visits: Map<string, AgentVisit>; pinned?: string } | undefined {
  if (!Check(saved, value) || value.ownerSessionId !== ownerSessionId) {
    return;
  }
  // The restored visit store owns its copies, never mutable session-entry data.
  const visits = new Map<string, AgentVisit>(structuredClone(value.visits));
  for (const current of visits.values()) {
    for (const sent of current.outbox) {
      if (sent.status === "sending") {
        sent.status = "unconfirmed";
      }
    }
  }
  return { visits, pinned: value.pinned };
}
