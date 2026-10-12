import { isRecord, isUnknownArray, type UnknownRecord } from "../../shared/unknown.ts";
import {
  normalizeSessionInfo,
  type SessionInfo,
  type SessionSnapshot,
  type TopicSubscription,
  type TopicUpdate,
} from "../types.ts";

type Receipt = SessionSnapshot["receipts"][number];

function optionalReceiptFields(value: UnknownRecord): Pick<Receipt, "queued" | "reason"> {
  if (
    (value.queued !== undefined && typeof value.queued !== "boolean") ||
    (value.reason !== undefined && typeof value.reason !== "string")
  ) {
    throw new Error("Invalid topic delivery receipts");
  }
  return {
    ...(typeof value.queued === "boolean" ? { queued: value.queued } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function optionalArray(value: unknown): readonly unknown[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!isUnknownArray(value)) {
    throw new Error("Invalid session snapshot row");
  }
  return value;
}

function receipt(value: unknown): Receipt {
  if (
    !isRecord(value) ||
    typeof value.to !== "string" ||
    typeof value.id !== "string" ||
    typeof value.accepted !== "boolean" ||
    typeof value.delivered !== "boolean"
  ) {
    throw new Error("Invalid topic delivery receipts");
  }
  const optional = optionalReceiptFields(value);
  return {
    to: value.to,
    id: value.id,
    accepted: value.accepted,
    delivered: value.delivered,
    ...optional,
  };
}

interface SessionParts {
  readonly info: SessionInfo;
  readonly topics: TopicUpdate[] | undefined;
  readonly subscriptions: TopicSubscription[] | undefined;
}

function appendRows<T>(
  previous: T[] | undefined,
  rows: readonly T[] | undefined,
  supplied: boolean,
): T[] | undefined {
  if (rows === undefined) {
    return supplied ? undefined : previous;
  }
  const result = previous ?? [];
  for (const row of rows) {
    result.push(row);
  }
  return result;
}

/** Multipart frames build a private cache; only a complete validated snapshot escapes. */
export class SnapshotReader {
  private readonly sessions = new Map<string, SessionParts>();
  private readonly receipts: Receipt[] = [];

  private addSession(row: unknown): void {
    if (!isRecord(row) || typeof row.id !== "string") {
      throw new Error("Invalid session snapshot row");
    }
    const topics = optionalArray(row.topics);
    const subscriptions = optionalArray(row.subscriptions);
    const previous = this.sessions.get(row.id);
    const info = normalizeSessionInfo({
      ...previous?.info,
      ...row,
      ...(topics !== undefined ? { topics } : {}),
      ...(subscriptions !== undefined ? { subscriptions } : {}),
    });
    if (!info) {
      throw new Error("Invalid session snapshot");
    }
    const { topics: newTopics, subscriptions: newSubscriptions, ...identity } = info;
    this.sessions.set(info.id, {
      info: identity,
      topics: appendRows(previous?.topics, newTopics, "topics" in row),
      subscriptions: appendRows(previous?.subscriptions, newSubscriptions, "subscriptions" in row),
    });
  }

  append(sessions: readonly unknown[], receipts: unknown): void {
    for (const row of sessions) {
      this.addSession(row);
    }
    if (receipts === undefined) {
      return;
    }
    if (!isUnknownArray(receipts)) {
      throw new Error("Invalid topic delivery receipts");
    }
    this.receipts.push(...receipts.map(receipt));
  }

  finish(): SessionSnapshot {
    const sessions: SessionInfo[] = [];
    for (const { info, topics, subscriptions } of this.sessions.values()) {
      sessions.push({
        ...info,
        ...(topics !== undefined ? { topics } : {}),
        ...(subscriptions !== undefined ? { subscriptions } : {}),
      });
    }
    return { sessions, receipts: this.receipts };
  }
}
