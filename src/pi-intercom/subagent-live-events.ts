import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IntercomClient } from "./broker/client.ts";
import { formatSessionTarget, resolveSessionTarget as resolveSessionTargetValue } from "./session-targets.ts";

const SUBAGENT_LIVE_INTERCOM_EVENT = "subagent:live-intercom";
const SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT = "subagent:live-intercom-delivery";
const SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT = "subagent:intercom-health-request";
const SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT = "subagent:intercom-health-response";

type PiEvents = ExtensionAPI["events"];

type LiveEventDeps = {
  events: PiEvents;
  ensureConnected: () => Promise<IntercomClient>;
  resolveSessionTarget: (client: IntercomClient, target: string) => Promise<string | null | undefined>;
  currentSessionTargetMatches: (requestedTarget: string, resolvedTarget?: string, client?: IntercomClient) => boolean;
  getLivenessCheck: () => () => boolean;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitLiveDelivery(events: PiEvents, requestId: string | undefined, delivered: boolean, reason?: string): void {
  if (!requestId) return;
  events.emit(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, {
    requestId,
    delivered,
    ...(reason ? { reason } : {}),
  });
}

function parseLiveMessagePayload(payload: unknown): { requestId: string; to: string; message: string; delivery: "queue" | "steer" } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const parsed = payload as { requestId?: unknown; to?: unknown; message?: unknown; delivery?: unknown };
  if (typeof parsed.requestId !== "string" || typeof parsed.to !== "string" || typeof parsed.message !== "string") return undefined;
  return {
    requestId: parsed.requestId,
    to: parsed.to,
    message: parsed.message,
    delivery: parsed.delivery === "queue" ? "queue" : "steer",
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
      const result = await activeClient.send(target, { text: parsed.message, delivery: parsed.delivery });
      if (isLive()) emitLiveDelivery(deps.events, parsed.requestId, result.delivered, result.reason);
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
  if (!parsed || parsed.targets.length === 0) return;
  const isLive = deps.getLivenessCheck();
  void (async () => {
    if (!isLive()) return;
    try {
      const activeClient = await deps.ensureConnected();
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
      deps.events.emit(SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT, { requestId: parsed.requestId, health });
    } catch {
      deps.events.emit(SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT, { requestId: parsed.requestId, health: parsed.targets.map((target) => ({ target, status: "missing" })) });
    }
  })();
}

export function registerSubagentLiveEventHandlers(deps: LiveEventDeps): Array<() => void> {
  return [
    deps.events.on(SUBAGENT_LIVE_INTERCOM_EVENT, (payload) => relayLiveSubagentMessage(payload, deps)),
    deps.events.on(SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT, (payload) => answerLiveIntercomHealth(payload, deps)),
  ];
}
