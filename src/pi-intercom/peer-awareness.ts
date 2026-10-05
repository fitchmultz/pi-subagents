import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Connection } from "./connection.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { IntercomTransport } from "./transport.ts";
import { isBrokerRunning } from "./broker/spawn.ts";
import { settleWithin } from "./async.ts";
import { formatPeerAwarenessHint, PEER_AWARENESS_HINT } from "./session-targets.ts";
import { setPromptSection } from "../shared/prompt-sections.ts";
interface AwarenessAttempt {
  readonly ctx: ExtensionContext;
  readonly generation: number;
  readonly deadline: number;
}
/** Pins one byte-stable hint after seeing peers; fleet churn never rewrites it. */
export class PeerAwareness {
  private pinned = false;
  private readonly connection: Connection;
  private readonly lifecycle: Lifecycle;
  constructor(connection: Connection, lifecycle: Lifecycle) {
    this.connection = connection;
    this.lifecycle = lifecycle;
  }
  reset(): void {
    this.pinned = false;
  }
  private async available(attempt: AwarenessAttempt): Promise<IntercomTransport | null> {
    const current = this.connection.active;
    if (current?.isConnected() === true) {
      return current;
    }
    this.connection.clearStartup();
    const available = await settleWithin(() => isBrokerRunning(), 75);
    const budget = attempt.deadline - Date.now();
    const active =
      available === true && budget > 0
        ? await settleWithin(() => this.connection.ensure("peer-awareness"), budget)
        : null;
    if (!active && this.lifecycle.live(attempt.ctx, attempt.generation)) {
      this.connection.scheduleStartup(attempt.ctx, attempt.generation);
    }
    return active;
  }
  private async hint(attempt: AwarenessAttempt): Promise<string | undefined> {
    const active = await this.available(attempt);
    if (!active) {
      return;
    }
    const id = active.sessionId ?? "";
    const remaining = attempt.deadline - Date.now();
    if (id === "" || remaining <= 0 || !this.lifecycle.live(attempt.ctx, attempt.generation)) {
      return;
    }
    const sessions = await settleWithin(() => active.listSessions(), remaining);
    if (
      !sessions ||
      this.connection.active !== active ||
      !this.lifecycle.live(attempt.ctx, attempt.generation)
    ) {
      return;
    }
    return formatPeerAwarenessHint(sessions, id);
  }
  async beforeStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
    const generation = this.lifecycle.generation;
    if (!this.lifecycle.live(ctx, generation)) {
      return;
    }
    if (this.pinned) {
      setPromptSection(event.systemPromptOptions, "intercom_peers", PEER_AWARENESS_HINT);
      return;
    }
    const hint = await this.hint({ ctx, generation, deadline: Date.now() + 75 });
    if (hint === undefined || hint === "") {
      return;
    }
    this.pinned = true;
    setPromptSection(event.systemPromptOptions, "intercom_peers", hint);
  }
}
