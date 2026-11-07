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

type SnapshotPhase =
  | {
      readonly kind: "open";
      readonly sessions: Map<string, SessionParts>;
      readonly receipts: Receipt[];
    }
  | { readonly kind: "finished" | "failed" };

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
  private phase: SnapshotPhase = { kind: "open", sessions: new Map(), receipts: [] };

  private open(): Extract<SnapshotPhase, { readonly kind: "open" }> {
    if (this.phase.kind !== "open") {
      throw new Error(`Session snapshot is ${this.phase.kind}`);
    }
    return this.phase;
  }

  fail(): void {
    if (this.phase.kind === "open") {
      this.phase = { kind: "failed" };
    }
  }

  private addSession(state: Extract<SnapshotPhase, { readonly kind: "open" }>, row: unknown): void {
    if (!isRecord(row) || typeof row.id !== "string") {
      throw new Error("Invalid session snapshot row");
    }
    const topics = optionalArray(row.topics);
    const subscriptions = optionalArray(row.subscriptions);
    const previous = state.sessions.get(row.id);
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
    state.sessions.set(info.id, {
      info: identity,
      topics: appendRows(previous?.topics, newTopics, "topics" in row),
      subscriptions: appendRows(previous?.subscriptions, newSubscriptions, "subscriptions" in row),
    });
  }

  append(sessions: readonly unknown[], receipts: unknown): void {
    const state = this.open();
    try {
      for (const row of sessions) {
        this.addSession(state, row);
      }
      if (receipts === undefined) {
        return;
      }
      if (!isUnknownArray(receipts)) {
        throw new Error("Invalid topic delivery receipts");
      }
      state.receipts.push(...receipts.map(receipt));
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  finish(): SessionSnapshot {
    const state = this.open();
    const sessions: SessionInfo[] = [];
    for (const { info, topics, subscriptions } of state.sessions.values()) {
      sessions.push({
        ...info,
        ...(topics !== undefined ? { topics } : {}),
        ...(subscriptions !== undefined ? { subscriptions } : {}),
      });
    }
    this.phase = { kind: "finished" };
    return { sessions, receipts: state.receipts };
  }
}
