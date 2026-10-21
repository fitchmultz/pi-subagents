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

export default function piIntercomExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const lifecycle = new IntercomLifecycle(pi, config, readIntercomLineage());
  const replies = new ReplyTracker(config.askTimeoutMs);
  const journal = new InboundJournal(pi, lifecycle, replies);
  const wait = new ReplyWait(lifecycle, config.askTimeoutMs);
  const connection = new IntercomConnection(lifecycle, config, {
    restoring: () => delivery.restoring,
    pendingAsks: () => replies.listPending().length,
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
  });
  const delivery = new InboundDeliveryOwner(pi, lifecycle, journal, {
    replies,
    syncStatus: () => connection.syncStatus(),
  });
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
}
