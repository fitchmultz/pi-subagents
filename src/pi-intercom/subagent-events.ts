import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Lifecycle } from "./lifecycle.ts";
import { resolveConnectedTarget, type Connection } from "./connection.ts";
import type { InboundDeliveryHandle } from "./inbound-delivery.ts";
import type { Journal } from "./inbound-journal.ts";
import type { IntercomSessionScope, SubagentCompletion } from "./runtime-types.ts";
import { isCompletedChild } from "./inbound-record.ts";
import { isRecord, isUnknownArray, errorMessage } from "./validation.ts";
import { registerSubagentLiveEventHandlers } from "./subagent-live-events.ts";
interface RelayPayload {
  readonly to: string;
  readonly message: string;
  readonly requestId?: string;
  readonly source?: "foreground" | "async";
  readonly completion?: SubagentCompletion;
}
function relayCompletion(
  payload: Readonly<Record<string, unknown>>,
  source: RelayPayload["source"],
): SubagentCompletion | undefined {
  const children = isUnknownArray(payload.children)
    ? payload.children.filter(isCompletedChild)
    : [];
  if (
    source === undefined ||
    typeof payload.runId !== "string" ||
    typeof payload.status !== "string" ||
    children.length === 0
  ) {
    return;
  }
  return {
    runId: payload.runId,
    status: payload.status,
    children,
    ...(typeof payload.completionId === "string" ? { completionId: payload.completionId } : {}),
  };
}
function parseRelay(payload: unknown): RelayPayload | null {
  if (!isRecord(payload) || typeof payload.to !== "string" || typeof payload.message !== "string") {
    return null;
  }
  const source =
    payload.source === "foreground" || payload.source === "async" ? payload.source : undefined;
  const completion = relayCompletion(payload, source);
  return {
    to: payload.to,
    message: payload.message,
    requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
    source,
    completion,
  };
}
interface RelayOptions {
  readonly sender: "subagent-control" | "subagent-result";
  readonly status: string;
  readonly errorEntryType: string;
  readonly acknowledge?: boolean;
}
interface BridgeOwners {
  readonly pi: ExtensionAPI;
  readonly journal: Journal;
  readonly open: (ctx: ExtensionContext, scope?: IntercomSessionScope) => Promise<void>;
}
/** Owns event subscriptions and detached event work; stop prevents new admission. */
export class SubagentEventBridges {
  private unsubscribes: (() => void)[] = [];
  private active = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly lifecycle: Lifecycle;
  private readonly connection: Connection;
  private readonly delivery: InboundDeliveryHandle;
  private readonly owners: BridgeOwners;
  constructor(
    lifecycle: Lifecycle,
    connection: Connection,
    delivery: InboundDeliveryHandle,
    owners: BridgeOwners,
  ) {
    this.lifecycle = lifecycle;
    this.connection = connection;
    this.delivery = delivery;
    this.owners = owners;
  }
  private own(operation: () => Promise<void>): void {
    const task = operation();
    this.pending.add(task);
    task
      .then(
        () => {
          this.pending.delete(task);
        },
        (error: unknown) => {
          this.pending.delete(task);
          console.error("Intercom event bridge failed:", error);
        },
      )
      .catch((error: unknown) => {
        console.error("Intercom event bridge cleanup failed:", error);
      });
  }
  stop(): void {
    for (const unsubscribe of this.unsubscribes) {
      try {
        unsubscribe();
      } catch {
        /* Best-effort cleanup during native reload/replacement. */
      }
    }
    this.unsubscribes = [];
    this.active = false;
  }
  async drain(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
  private acknowledge(requestId: string | undefined, delivered: boolean, error?: unknown): void {
    if (requestId === undefined || requestId === "") {
      return;
    }
    this.owners.pi.events.emit("subagent:result-intercom-delivery", {
      requestId,
      delivered,
      ...(error !== undefined ? { error: errorMessage(error) } : {}),
    });
  }
  private isLive(generation: number): boolean {
    return (
      !this.lifecycle.runtimeStarted ||
      (this.lifecycle.generation === generation && this.lifecycle.live() !== null)
    );
  }
  private async remote(
    parsed: RelayPayload,
    options: RelayOptions,
    generation: number,
  ): Promise<boolean> {
    if (this.lifecycle.targetMatches(parsed.to)) {
      return false;
    }
    const client = await this.connection.ensure("background");
    const target = (await resolveConnectedTarget(client, parsed.to)) ?? parsed.to;
    if (!this.isLive(generation)) {
      return true;
    }
    if (this.lifecycle.targetMatches(parsed.to, target, client.sessionId)) {
      return false;
    }
    const result = await client.send(target, { text: parsed.message });
    if (!this.isLive(generation)) {
      return true;
    }
    if (!result.accepted) {
      throw new Error(result.reason ?? "Session may not exist or has disconnected.");
    }
    if (options.acknowledge === true) {
      this.acknowledge(parsed.requestId, true);
    }
    return true;
  }
  private async relay(payload: unknown, options: RelayOptions): Promise<void> {
    const parsed = parseRelay(payload);
    if (!parsed) {
      return;
    }
    const generation = this.lifecycle.generation;
    try {
      const restoring = this.delivery.restoring;
      if (restoring) {
        await restoring;
      }
      if (!this.isLive(generation) || (await this.remote(parsed, options, generation))) {
        return;
      }
      this.local(parsed, options);
    } catch (error) {
      if (!this.isLive(generation)) {
        return;
      }
      this.owners.pi.appendEntry(options.errorEntryType, {
        to: parsed.to,
        message: parsed.message,
        error: errorMessage(error),
        timestamp: Date.now(),
      });
      if (options.acknowledge === true) {
        this.acknowledge(parsed.requestId, false, error);
      }
    }
  }
  private local(parsed: RelayPayload, options: RelayOptions): void {
    const ownedControl =
      options.sender === "subagent-control" &&
      (parsed.source === "foreground" || parsed.source === "async");
    if (!ownedControl) {
      this.delivery.local(options.sender, options.status, {
        text: parsed.message,
        completion: parsed.completion,
      });
    }
    if (options.acknowledge === true) {
      this.acknowledge(parsed.requestId, true);
    }
  }
  private registerCoordination(): (() => void)[] {
    const { pi, journal, open } = this.owners;
    return [
      pi.events.on("subagent:supervisor-question-resolved", (payload) => {
        if (!isRecord(payload) || typeof payload.questionId !== "string") {
          return;
        }
        journal.retire(
          payload.questionId,
          journal.remove(payload.questionId) ? "discarded" : "reply-retired",
        );
        this.connection.syncStatus();
      }),
      pi.events.on("intercom:open", () => {
        const ctx = this.lifecycle.live();
        if (ctx?.mode === "tui") {
          this.own(() => open(ctx, "all"));
        }
      }),
      pi.events.on("subagent:intercom-identity-request", (payload) => {
        const client = this.connection.active;
        if (
          isRecord(payload) &&
          typeof payload.requestId === "string" &&
          client?.isConnected() === true &&
          client.sessionId !== null &&
          client.sessionId !== ""
        ) {
          pi.events.emit("subagent:intercom-identity-response", {
            requestId: payload.requestId,
            sessionId: client.sessionId,
          });
        }
      }),
      pi.events.on("subagent:control-intercom", (payload) => {
        this.own(() =>
          this.relay(payload, {
            sender: "subagent-control",
            status: "needs_attention",
            errorEntryType: "intercom_control_error",
          }),
        );
      }),
      pi.events.on("subagent:result-intercom", (payload) => {
        this.own(() =>
          this.relay(payload, {
            sender: "subagent-result",
            status: "result",
            errorEntryType: "intercom_result_error",
            acknowledge: true,
          }),
        );
      }),
    ];
  }
  start(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.unsubscribes = [
      ...registerSubagentLiveEventHandlers({
        events: this.owners.pi.events,
        ensureConnected: () => this.connection.ensure("background"),
        getConnection: () => ({
          client: this.connection.active,
          connecting: this.connection.isConnecting,
          started: this.lifecycle.runtimeStarted,
        }),
        resolveSessionTarget: resolveConnectedTarget,
        currentSessionTargetMatches: (to, resolved, client) =>
          this.lifecycle.targetMatches(to, resolved, client?.sessionId),
        getLivenessCheck: () => {
          const generation = this.lifecycle.generation;
          return () => this.isLive(generation);
        },
        own: (operation) => {
          this.own(operation);
        },
      }),
      ...this.registerCoordination(),
    ];
  }
}
