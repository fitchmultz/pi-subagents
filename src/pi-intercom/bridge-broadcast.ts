import { randomUUID } from "node:crypto";
import { Fault, BroadcastFault } from "./bridge-protocol.ts";
import type { GroupTargets } from "./bridge-groups.ts";
import type { UnknownRecord } from "../shared/unknown.ts";
import type { Session } from "./bridge-session.ts";
import type { RequestContext } from "./bridge-http.ts";

export async function broadcastTargets(
  session: Readonly<Session>,
  targets: GroupTargets,
  message: string,
  context: RequestContext,
): Promise<UnknownRecord> {
  const receipts: UnknownRecord[] = [];
  for (const peer of targets.peers) {
    if (context.signal.aborted) {
      receipts.push({
        peer: peer.id,
        attempted: false,
        error: {
          code: "not_attempted",
          message: "Broadcast stopped before sending.",
          deliveryUnknown: false,
        },
      });
      continue;
    }
    const id = randomUUID();
    try {
      // No hidden retries; sequential admission bounds broker pressure.
      // oxlint-disable-next-line no-await-in-loop
      const receipt = await session.send(peer.id, message, context, { messageId: id });
      receipts.push({ peer: peer.id, attempted: true, ...receipt });
    } catch (error) {
      const fault =
        error instanceof Fault
          ? error
          : new Fault(503, "send_unconfirmed", "Target delivery could not be confirmed.");
      receipts.push({
        peer: peer.id,
        attempted: true,
        error: {
          code: fault.code,
          message: fault.message,
          ...fault.details,
          id,
          deliveryUnknown: fault.details.accepted !== false,
        },
      });
    }
  }
  const failed =
    receipts.filter((receipt) => receipt.accepted !== true).length + targets.errors.length;
  const outcome = {
    status: failed === 0 ? "complete" : "partial",
    receipts,
    errors: targets.errors,
  };
  // Transport closure must not erase outcomes, or disclose them after authorization is revoked.
  session.authorize();
  try {
    session.guard(context.signal);
  } catch (error) {
    if (error instanceof Fault) {
      throw new BroadcastFault(error, outcome);
    }
    throw error;
  }
  return outcome;
}
