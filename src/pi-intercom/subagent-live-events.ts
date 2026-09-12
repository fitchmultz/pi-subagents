import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IntercomClient } from "./broker/client.ts";
import type { SubagentIntercomConnection } from "../shared/types.ts";
import { formatSessionTarget, resolveSessionTarget as resolveSessionTargetValue } from "./session-targets.ts";
import { isAttachment, isHumanMessageOrigin, type Attachment, type HumanMessageOrigin } from "./types.ts";

const SUBAGENT_LIVE_INTERCOM_EVENT = "subagent:live-intercom";
const SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT = "subagent:live-intercom-delivery";
const SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT = "subagent:intercom-health-request";
const SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT = "subagent:intercom-health-response";

type PiEvents = ExtensionAPI["events"];

type LiveEventDeps = {
  events: PiEvents;
  ensureConnected: () => Promise<IntercomClient>;
  getConnection: () => { client: IntercomClient | null; connecting: boolean; started: boolean };
  resolveSessionTarget: (client: IntercomClient, target: string) => Promise<string | null | undefined>;
  currentSessionTargetMatches: (requestedTarget: string, resolvedTarget?: string, client?: IntercomClient) => boolean;
  getLivenessCheck: () => () => boolean;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitLiveDelivery(events: PiEvents, requestId: string | undefined, delivered: boolean, reason?: string, receipt?: { id: string; accepted: boolean; queued?: boolean }): void {
  if (!requestId) return;
  events.emit(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, {
    requestId,
    delivered,
    ...(receipt ? { messageId: receipt.id, accepted: receipt.accepted, queued: receipt.queued } : {}),
    ...(reason ? { reason } : {}),
  });
}

function parseLiveMessagePayload(payload: unknown): { requestId: string; to: string; message: string; delivery: "queue" | "steer"; messageId?: string; human?: HumanMessageOrigin; attachments?: Attachment[] } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const parsed = payload as { requestId?: unknown; to?: unknown; message?: unknown; delivery?: unknown; messageId?: unknown; human?: unknown; attachments?: unknown };
  if (typeof parsed.requestId !== "string" || typeof parsed.to !== "string" || typeof parsed.message !== "string") return undefined;
  return {
    requestId: parsed.requestId,
    to: parsed.to,
    message: parsed.message,
    delivery: parsed.delivery === "queue" ? "queue" : "steer",
    ...(typeof parsed.messageId === "string" ? { messageId: parsed.messageId } : {}),
    ...(isHumanMessageOrigin(parsed.human) ? { human: parsed.human } : {}),
    ...(Array.isArray(parsed.attachments) && parsed.attachments.every(isAttachment) ? { attachments: parsed.attachments } : {}),
  };
}

function relayLiveSubagentMessage(payload: unknown, deps: LiveEventDeps): void {
  const parsed = parseLiveMessagePayload(payload);
  if (!parsed) return;
  const isLive = deps.getLivenessCheck();
  void (async () => {
    if (!isLive()) return;
    let activeClient: IntercomClient;
    let target: string;
    try {
      activeClient = await deps.ensureConnected();
      target = await deps.resolveSessionTarget(activeClient, parsed.to) ?? parsed.to;
    } catch (error) {
      if (isLive()) emitLiveDelivery(deps.events, parsed.requestId, false, getErrorMessage(error));
      return;
    }
    if (!isLive()) return;
    if (deps.currentSessionTargetMatches(parsed.to, target, activeClient)) {
      emitLiveDelivery(deps.events, parsed.requestId, false, "Cannot message the current session");
      return;
    }
    try {
      const result = await activeClient.send(target, { text: parsed.message, delivery: parsed.delivery, messageId: parsed.messageId, human: parsed.human, attachments: parsed.attachments });
      if (isLive()) emitLiveDelivery(deps.events, parsed.requestId, result.delivered, result.reason, result);
    } catch (error) {
      if (isLive()) emitLiveDelivery(deps.events, parsed.requestId, false, getErrorMessage(error));
    }
  })();
}

function parseHealthPayload(payload: unknown): { requestId: string; targets: string[] } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const parsed = payload as { requestId?: unknown; targets?: unknown };
  if (typeof parsed.requestId !== "string" || !Array.isArray(parsed.targets)) return undefined;
  const targets = parsed.targets.filter((target): target is string => typeof target === "string" && target.trim().length > 0);
  return { requestId: parsed.requestId, targets };
}

function answerLiveIntercomHealth(payload: unknown, deps: LiveEventDeps): void {
  const parsed = parseHealthPayload(payload);
  if (!parsed) return;
  const isLive = deps.getLivenessCheck();
  const connectionSnapshot = (): SubagentIntercomConnection => {
    const { client, connecting, started } = deps.getConnection();
    return { status: !started ? "unknown" : connecting ? "connecting" : client?.isConnected() ? "unknown" : "disconnected", ...(client?.sessionId ? { sessionId: client.sessionId } : {}) };
  };
  const respond = (health: unknown[], connection: SubagentIntercomConnection) => {
    if (isLive()) deps.events.emit(SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT, { requestId: parsed.requestId, health, connection });
  };
  void (async () => {
    if (!isLive()) return;
    try {
      // An empty target list is a read-only check of this bridge, not a reconnect request.
      const activeClient = parsed.targets.length ? await deps.ensureConnected() : deps.getConnection().client;
      if (!activeClient?.isConnected()) { respond([], connectionSnapshot()); return; }
      const sessions = await activeClient.listSessions();
      const health = parsed.targets.map((target) => {
        const resolution = resolveSessionTargetValue(sessions, target);
        if (resolution.status !== "found") return { target, status: resolution.status };
        const session = resolution.target!;
        return {
          target,
          status: "registered" as const,
          resolvedTarget: formatSessionTarget(session, sessions),
          sessionId: session.id,
          ...(session.name ? { sessionName: session.name } : {}),
          ...(session.status ? { sessionStatus: session.status } : {}),
          ...(session.acceptsAsks !== undefined ? { acceptsAsks: session.acceptsAsks } : {}),
          ...(session.pendingAsks !== undefined ? { pendingAsks: session.pendingAsks } : {}),
          ...(session.lastSeen !== undefined ? { lastSeen: session.lastSeen } : {}),
          ...(session.lastIntercomActivity !== undefined ? { lastIntercomActivity: session.lastIntercomActivity } : {}),
        };
      });
      const registered = activeClient.isConnected() && sessions.some((session) => session.id === activeClient.sessionId);
      respond(health, registered ? { status: "connected", sessionId: activeClient.sessionId! } : { ...connectionSnapshot(), reason: "Current broker registration was not confirmed." });
    } catch (error) {
      respond(parsed.targets.map((target) => ({ target, status: "missing" })), { ...connectionSnapshot(), reason: getErrorMessage(error) });
    }
  })();
}

export function registerSubagentLiveEventHandlers(deps: LiveEventDeps): Array<() => void> {
  return [
    deps.events.on(SUBAGENT_LIVE_INTERCOM_EVENT, (payload) => relayLiveSubagentMessage(payload, deps)),
    deps.events.on(SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT, (payload) => answerLiveIntercomHealth(payload, deps)),
  ];
}
