import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { readIntercomLineage } from "./identity.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { IntercomLifecycle } from "./lifecycle.ts";
import { InboundJournal } from "./inbound-journal.ts";
import { InboundDeliveryOwner } from "./inbound-delivery.ts";
import { ReplyWait } from "./reply-wait.ts";
import { IntercomConnection } from "./connection.ts";
import { IntercomInbound } from "./inbound.ts";
import { IntercomOutbound } from "./outbound.ts";
import { IntercomInspection } from "./inspection.ts";
import { IntercomTools } from "./tools.ts";
import { IntercomSessionEvents } from "./session-events.ts";
import { registerIntercomTools } from "./tool-registration.ts";
import { isParkRequest, PARK, PARKED_HISTORY, WAKE, type WakeResult } from "../shared/parking.ts";
import type { NativeHistory } from "./last-message.ts";

/** The agent runtime answers for its exited parked child from the captured native session. */
function parkedHistory(pi: ExtensionAPI, peer: string): Promise<NativeHistory | undefined> {
  let history: Promise<NativeHistory | undefined> | undefined;
  pi.events.emit(PARKED_HISTORY, {
    peer,
    reply: (found: Promise<NativeHistory | undefined>) => {
      history = found;
    },
  });
  return history ?? Promise.reject(new Error("No agent runtime owns parked history."));
}

function wakeParked(pi: ExtensionAPI, peer: string, signal?: AbortSignal): Promise<WakeResult> {
  let result: Promise<WakeResult> | undefined;
  pi.events.emit(WAKE, {
    peer,
    signal,
    reply: (outcome: Promise<WakeResult>) => {
      result = outcome;
    },
  });
  return (
    result ??
    Promise.resolve({ status: "failed", reason: "No agent runtime owns this parked child." })
  );
}

export default function piIntercomExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const lifecycle = new IntercomLifecycle(pi, config, readIntercomLineage());
  const replies = new ReplyTracker(config.askTimeoutMs);
  const journal = new InboundJournal(pi, lifecycle, replies);
  const wait = new ReplyWait(lifecycle, config.askTimeoutMs);
  const connection = new IntercomConnection(lifecycle, config, {
    restoring: () => delivery.restoring,
    pendingAsks: () => replies.listPending().length,
    receipt: (query) => journal.receipt(query),
    incoming: (ctx, from, message) => inbound.receive(ctx, from, message),
    peerLeft: (id) => {
      wait.peerDisconnected(id);
      journal.peerLeft(id);
    },
    disconnected: (error) => {
      wait.reject(
        new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }),
      );
    },
    parkedHistory: (peer) => parkedHistory(pi, peer.id),
    wake: (peer, signal) => wakeParked(pi, peer, signal),
    wakeFailed: (peer, messageId, reason) => wait.wakeFailed(peer, messageId, reason),
  });
  const delivery = new InboundDeliveryOwner(pi, lifecycle, journal, {
    replies,
    syncStatus: () => connection.syncStatus(),
  });
  lifecycle.registerContextEvents(() => connection.syncStatus());
  const inbound = new IntercomInbound(lifecycle, config, {
    delivery,
    journal,
    replies,
    wait,
    connection,
  });
  const outbound = new IntercomOutbound({ pi, lifecycle, connection, replies, wait }, config);
  const inspection = new IntercomInspection(journal, replies);
  const tools = new IntercomTools({ connection, outbound, inspection });
  new IntercomSessionEvents(pi, {
    lifecycle,
    connection,
    delivery,
    journal,
    replies,
    wait,
  }).register();
  registerIntercomTools(pi, tools);
  pi.events.on(PARK, (request) => {
    if (isParkRequest(request)) {
      request.reply(request.park ? connection.park() : connection.unpark());
    }
  });
  // Native fork sleep readiness; it vetoes only this package's own parking, never other saves.
  Reflect.apply(pi.on.bind(pi), undefined, [
    "working_session_save",
    () =>
      !connection.parking
        ? undefined
        : {
            blockers: [
              inbound.receiving > 0 && "intercom is receiving a message",
              journal.size > 0 && "intercom inbound messages await delivery",
              replies.listPending().length > 0 && "intercom asks await replies",
              wait.waiting && "intercom is waiting for a reply",
              (delivery.restoring !== undefined || delivery.batching) &&
                "intercom delivery is restoring",
              connection.reconnected && "intercom reconnected while parking",
            ].filter((blocker) => typeof blocker === "string"),
          },
  ]);
}
