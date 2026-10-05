import { randomUUID } from "node:crypto";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { errorMessage, isRecord } from "../shared/unknown.ts";

export interface LiveMessageReceipt {
  delivered: boolean;
  accepted?: boolean;
  queued?: boolean;
  messageId?: string;
  reason?: string;
}
import {
  SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT,
  SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT,
  SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT,
  SUBAGENT_LIVE_INTERCOM_EVENT,
  type IntercomEventBus,
  type SubagentLiveIntercomHealth,
  type SubagentIntercomConnection,
} from "../shared/types.ts";

export async function sendLiveSubagentMessage(
  events: ReadonlyInput<IntercomEventBus>,
  input: ReadonlyInput<{
    to: string;
    message: string;
    delivery?: "steer" | "queue";
    timeoutMs?: number;
    signal?: AbortSignal;
    extra?: Record<string, unknown>;
  }>,
): Promise<LiveMessageReceipt> {
  if (typeof events.on !== "function" || typeof events.emit !== "function") {
    return { delivered: false, reason: "pi-intercom bridge unavailable" };
  }
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Readonly<LiveMessageReceipt>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      unsubscribe();
      resolve(result);
    };
    const abort = () =>
      finish({ delivered: false, reason: "Message view/session closed; delivery not confirmed." });
    const unsubscribe = events.on(SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT, (data) => {
      if (!isRecord(data)) {
        return;
      }
      const payload = data;
      if (payload.requestId !== requestId) {
        return;
      }
      finish({
        delivered: payload.delivered === true,
        ...(typeof payload.accepted === "boolean" ? { accepted: payload.accepted } : {}),
        ...(typeof payload.queued === "boolean" ? { queued: payload.queued } : {}),
        ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
      });
    });
    const timer = setTimeout(
      () => finish({ delivered: false, reason: "pi-intercom bridge unavailable" }),
      input.timeoutMs ?? 500,
    );
    if (input.signal?.aborted === true) {
      abort();
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      events.emit(SUBAGENT_LIVE_INTERCOM_EVENT, {
        ...input.extra,
        requestId,
        to: input.to,
        message: input.message,
        delivery: input.delivery ?? "steer",
      });
    } catch (error) {
      finish({ delivered: false, reason: errorMessage(error) });
    }
  });
}

function parseConnection(value: unknown): SubagentIntercomConnection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { status } = value;
  if (
    status !== "connected" &&
    status !== "disconnected" &&
    status !== "connecting" &&
    status !== "unknown"
  ) {
    return undefined;
  }
  return {
    status,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function healthMetadata(
  value: Readonly<Record<string, unknown>>,
): Omit<SubagentLiveIntercomHealth, "target" | "status"> {
  return {
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.sessionName === "string" ? { sessionName: value.sessionName } : {}),
    ...(typeof value.sessionStatus === "string" ? { sessionStatus: value.sessionStatus } : {}),
    ...(typeof value.acceptsAsks === "boolean" ? { acceptsAsks: value.acceptsAsks } : {}),
    ...(typeof value.pendingAsks === "number" ? { pendingAsks: value.pendingAsks } : {}),
  };
}

function parseHealth(value: unknown): SubagentLiveIntercomHealth | undefined {
  if (!isRecord(value) || typeof value.target !== "string") {
    return undefined;
  }
  const { status } = value;
  if (
    status !== "registered" &&
    status !== "none" &&
    status !== "missing" &&
    status !== "ambiguous" &&
    status !== "prefix_too_short"
  ) {
    return undefined;
  }
  return {
    target: value.target,
    status,
    ...healthMetadata(value),
  };
}

export async function queryLiveIntercomHealth(
  events: ReadonlyInput<IntercomEventBus>,
  targets: readonly string[],
  timeoutMs = 300,
): Promise<Map<string, SubagentLiveIntercomHealth>> {
  if (!targets.some((target) => target.trim().length > 0)) {
    return new Map();
  }
  return (await queryLiveIntercomStatus(events, targets, timeoutMs)).health;
}

export async function queryLiveIntercomStatus(
  events: ReadonlyInput<IntercomEventBus>,
  targets: readonly string[] = [],
  timeoutMs = 300,
): Promise<{
  health: Map<string, SubagentLiveIntercomHealth>;
  connection?: SubagentIntercomConnection;
}> {
  const uniqueTargets = [...new Set(targets.map((target) => target.trim()).filter(Boolean))];
  if (typeof events.on !== "function" || typeof events.emit !== "function") {
    return { health: new Map() };
  }
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      items: ReadonlyInput<SubagentLiveIntercomHealth[]> = [],
      connection?: Readonly<SubagentIntercomConnection>,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribe?.();
      resolve({ health: new Map(items.map((item) => [item.target, item])), connection });
    };
    try {
      unsubscribe = events.on(SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT, (data) => {
        if (!isRecord(data)) {
          return;
        }
        const payload = data;
        if (payload.requestId !== requestId || !Array.isArray(payload.health)) {
          return;
        }
        const connection = parseConnection(payload.connection);
        finish(
          payload.health.flatMap((item: unknown) => {
            const health = parseHealth(item);
            return health ? [health] : [];
          }),
          connection,
        );
      });
      timer = setTimeout(() => finish(), timeoutMs);
      events.emit(SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT, { requestId, targets: uniqueTargets });
    } catch {
      finish();
    }
  });
}
