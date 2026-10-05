import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IntercomTransport } from "./transport.ts";
import type { SubagentIntercomConnection } from "../shared/types.ts";
import { formatSessionTarget, resolveSessionTarget } from "./session-targets.ts";
import {
  isAttachment,
  isHumanMessageOrigin,
  type Attachment,
  type HumanMessageOrigin,
  type SessionInfo,
} from "./types.ts";
import { errorMessage, isRecord, isUnknownArray } from "./validation.ts";
type PiEvents = Readonly<ExtensionAPI["events"]>;
interface LiveEventDeps {
  readonly events: PiEvents;
  readonly ensureConnected: () => Promise<IntercomTransport>;
  readonly getConnection: () => {
    readonly client: IntercomTransport | null;
    readonly connecting: boolean;
    readonly started: boolean;
  };
  readonly resolveSessionTarget: (
    client: IntercomTransport,
    target: string,
  ) => Promise<string | null | undefined>;
  readonly currentSessionTargetMatches: (
    requestedTarget: string,
    resolvedTarget?: string,
    client?: IntercomTransport,
  ) => boolean;
  readonly getLivenessCheck: () => () => boolean;
  readonly own?: (operation: () => Promise<void>) => void;
}
interface LivePayload {
  readonly requestId: string;
  readonly to: string;
  readonly message: string;
  readonly delivery: "queue" | "steer";
  readonly messageId?: string;
  readonly human?: HumanMessageOrigin;
  readonly attachments?: readonly Attachment[];
}
interface LiveReceipt {
  readonly id: string;
  readonly accepted: boolean;
  readonly queued?: boolean;
}
function emitDelivery(
  events: PiEvents,
  requestId: string | undefined,
  delivered: boolean,
  result: { readonly reason?: string; readonly receipt?: LiveReceipt } = {},
): void {
  if (requestId === undefined || requestId === "") {
    return;
  }
  const { reason, receipt } = result;
  events.emit("subagent:live-intercom-delivery", {
    requestId,
    delivered,
    ...(receipt
      ? { messageId: receipt.id, accepted: receipt.accepted, queued: receipt.queued }
      : {}),
    ...(reason !== undefined && reason !== "" ? { reason } : {}),
  });
}
function parseLivePayload(payload: unknown): LivePayload | undefined {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    typeof payload.to !== "string" ||
    typeof payload.message !== "string"
  ) {
    return;
  }
  const attachments = payload.attachments;
  return {
    requestId: payload.requestId,
    to: payload.to,
    message: payload.message,
    delivery: payload.delivery === "queue" ? "queue" : "steer",
    ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
    ...(isHumanMessageOrigin(payload.human) ? { human: payload.human } : {}),
    ...(isUnknownArray(attachments) && attachments.every(isAttachment) ? { attachments } : {}),
  };
}
async function relayLive(payload: unknown, deps: LiveEventDeps): Promise<void> {
  const parsed = parseLivePayload(payload);
  if (!parsed) {
    return;
  }
  const live = deps.getLivenessCheck();
  if (!live()) {
    return;
  }
  try {
    const client = await deps.ensureConnected();
    const target = (await deps.resolveSessionTarget(client, parsed.to)) ?? parsed.to;
    if (!live()) {
      return;
    }
    if (deps.currentSessionTargetMatches(parsed.to, target, client)) {
      emitDelivery(deps.events, parsed.requestId, false, {
        reason: "Cannot message the current session",
      });
      return;
    }
    const result = await client.send(target, {
      text: parsed.message,
      delivery: parsed.delivery,
      messageId: parsed.messageId,
      human: parsed.human,
      attachments: parsed.attachments,
    });
    if (live()) {
      emitDelivery(deps.events, parsed.requestId, result.delivered, {
        reason: result.reason,
        receipt: result,
      });
    }
  } catch (error) {
    if (live()) {
      emitDelivery(deps.events, parsed.requestId, false, { reason: errorMessage(error) });
    }
  }
}
function parseHealth(
  payload: unknown,
): { readonly requestId: string; readonly targets: readonly string[] } | undefined {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    !isUnknownArray(payload.targets)
  ) {
    return;
  }
  return {
    requestId: payload.requestId,
    targets: payload.targets.filter(
      (target): target is string => typeof target === "string" && target.trim().length > 0,
    ),
  };
}
function connectionSnapshot(deps: LiveEventDeps): SubagentIntercomConnection {
  const { client, connecting, started } = deps.getConnection();
  let status: SubagentIntercomConnection["status"] = "unknown";
  if (started) {
    if (connecting) {
      status = "connecting";
    } else if (client?.isConnected() !== true) {
      status = "disconnected";
    }
  }
  const id = client?.sessionId;
  return { status, ...(id !== undefined && id !== null && id !== "" ? { sessionId: id } : {}) };
}
function sessionNames(session: SessionInfo): Readonly<Record<string, string>> {
  return {
    ...(session.name !== undefined && session.name !== "" ? { sessionName: session.name } : {}),
    ...(session.status !== undefined && session.status !== ""
      ? { sessionStatus: session.status }
      : {}),
  };
}
async function answerHealth(payload: unknown, deps: LiveEventDeps): Promise<void> {
  const parsed = parseHealth(payload);
  if (!parsed) {
    return;
  }
  const live = deps.getLivenessCheck();
  const respond = (health: readonly unknown[], connection: SubagentIntercomConnection) => {
    if (live()) {
      deps.events.emit("subagent:intercom-health-response", {
        requestId: parsed.requestId,
        health,
        connection,
      });
    }
  };
  if (!live()) {
    return;
  }
  try {
    // Empty targets observe the bridge without reconnecting.
    const client =
      parsed.targets.length > 0 ? await deps.ensureConnected() : deps.getConnection().client;
    if (client?.isConnected() !== true) {
      respond([], connectionSnapshot(deps));
      return;
    }
    const sessions = await client.listSessions();
    const health = parsed.targets.map((target) => {
      const resolution = resolveSessionTarget(sessions, target);
      const session = resolution.target;
      if (resolution.status !== "found" || !session) {
        return { target, status: resolution.status };
      }
      return {
        target,
        status: "registered",
        resolvedTarget: formatSessionTarget(session, sessions),
        sessionId: session.id,
        ...sessionNames(session),
        ...(session.acceptsAsks !== undefined ? { acceptsAsks: session.acceptsAsks } : {}),
        ...(session.pendingAsks !== undefined ? { pendingAsks: session.pendingAsks } : {}),
        ...(session.lastSeen !== undefined ? { lastSeen: session.lastSeen } : {}),
        ...(session.lastIntercomActivity !== undefined
          ? { lastIntercomActivity: session.lastIntercomActivity }
          : {}),
      };
    });
    const id = client.sessionId;
    const registered = client.isConnected() && sessions.some((session) => session.id === id);
    respond(
      health,
      registered && id !== null
        ? { status: "connected", sessionId: id }
        : { ...connectionSnapshot(deps), reason: "Current broker registration was not confirmed." },
    );
  } catch (error) {
    respond(
      parsed.targets.map((target) => ({ target, status: "missing" })),
      { ...connectionSnapshot(deps), reason: errorMessage(error) },
    );
  }
}
function own(deps: LiveEventDeps, operation: () => Promise<void>): void {
  if (deps.own) {
    deps.own(operation);
    return;
  }
  operation().catch((error: unknown) => {
    console.error("Intercom live event failed:", error);
  });
}
export function registerSubagentLiveEventHandlers(deps: LiveEventDeps): (() => void)[] {
  return [
    deps.events.on("subagent:live-intercom", (payload) => {
      own(deps, () => relayLive(payload, deps));
    }),
    deps.events.on("subagent:intercom-health-request", (payload) => {
      own(deps, () => answerHealth(payload, deps));
    }),
  ];
}
