import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { readChildOrchestratorMetadata } from "./identity.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { IntercomTopics } from "./topics.ts";
import { IntercomLifecycle } from "./lifecycle.ts";
import { InboundJournal } from "./inbound-journal.ts";
import { InboundDeliveryOwner } from "./inbound-delivery.ts";
import { ReplyWait } from "./reply-wait.ts";
import { IntercomConnection } from "./connection.ts";
import { IntercomInbound } from "./inbound.ts";
import { IntercomOutbound } from "./outbound.ts";
import { IntercomInspection } from "./inspection.ts";
import { IntercomTopicActions } from "./topic-actions.ts";
import { IntercomSupervisor } from "./supervisor.ts";
import { IntercomTools } from "./tools.ts";
import { IntercomOverlay } from "./ui/overlay.ts";
import { SubagentEventBridges } from "./subagent-events.ts";
import { IntercomSessionEvents } from "./session-events.ts";
import { PeerAwareness } from "./peer-awareness.ts";
import { registerMessageRenderers } from "./ui/message-renderers.ts";
import { registerIntercomTools } from "./tool-registration.ts";

export default function piIntercomExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const child = readChildOrchestratorMetadata();
  const lifecycle = new IntercomLifecycle(pi, config);
  const replies = new ReplyTracker(config.askTimeoutMs);
  const topics = new IntercomTopics(pi, () => lifecycle.live());
  const journal = new InboundJournal(pi, lifecycle, replies);
  const wait = new ReplyWait(pi, lifecycle, config.askTimeoutMs);
  // Hooks are invoked only after construction, at a native session or event boundary.
  const connection = new IntercomConnection(lifecycle, config, topics, {
    restoring: () => delivery.restoring,
    pendingAsks: () => replies.listPending().length,
    incoming: (ctx, from, message) => inbound.receive(ctx, from, message),
    peerLeft: (id) => {
      wait.peerDisconnected(id);
      journal.peerLeft(id);
    },
    disconnected: (error) => {
      if (!wait.durable) {
        wait.reject(
          new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }),
        );
      }
    },
  });
  const delivery = new InboundDeliveryOwner(pi, lifecycle, journal, {
    replies,
    syncStatus: () => connection.syncStatus(),
  });
  const inbound = new IntercomInbound(lifecycle, config, {
    journal,
    delivery,
    replies,
    wait,
    connection,
    topics,
    child,
  });
  const outbound = new IntercomOutbound({ pi, lifecycle, connection, replies, wait }, config);
  const inspection = new IntercomInspection(journal, replies);
  const topicActions = new IntercomTopicActions({ pi, lifecycle, connection, topics });
  const tools = new IntercomTools({ connection, outbound, topicActions, topics, inspection });
  const supervisor = child
    ? new IntercomSupervisor({ pi, lifecycle, connection, wait }, child)
    : null;
  const overlay = new IntercomOverlay({ pi, lifecycle, connection, topics });
  const bridges = new SubagentEventBridges(lifecycle, connection, delivery, {
    pi,
    journal,
    open: (ctx, scope) => overlay.open(ctx, scope),
  });
  const awareness = child ? null : new PeerAwareness(connection, lifecycle);
  bridges.start();
  new IntercomSessionEvents(pi, {
    lifecycle,
    connection,
    delivery,
    journal,
    replies,
    wait,
    topics,
    bridges,
    supervisor,
    awareness,
  }).register();
  registerMessageRenderers(pi);
  registerIntercomTools(pi, tools, supervisor);
  overlay.register(config.shortcut);
}
