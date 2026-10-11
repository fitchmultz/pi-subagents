import { randomUUID } from "node:crypto";
import { isRecord } from "../shared/unknown.ts";
import {
  SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
  SUBAGENT_RESULT_INTERCOM_EVENT,
  type IntercomEventBus,
  type SubagentResultIntercomPayload,
} from "../shared/types.ts";

export async function deliverSubagentResultIntercomEvent(
  events: IntercomEventBus,
  payload: SubagentResultIntercomPayload,
  timeoutMs = 500,
): Promise<boolean> {
  return deliverSubagentIntercomMessageEvent(events, payload.to, payload.message, timeoutMs, {
    ...payload,
  });
}

/** Retained positional RPC adapter: correlation is installed before synchronous publication. */
export async function deliverSubagentIntercomMessageEvent(
  events: IntercomEventBus,
  to: string,
  message: string,
  timeoutMs = 500,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<boolean> {
  if (typeof events.on !== "function" || typeof events.emit !== "function") {
    return false;
  }
  const requestId = typeof extra.requestId === "string" ? extra.requestId : randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (delivered: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(delivered);
    };
    const unsubscribe = events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (data) => {
      if (!isRecord(data) || data.requestId !== requestId) {
        return;
      }
      finish(data.delivered === true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { ...extra, to, message, requestId });
    } catch {
      finish(false);
    }
  });
}
