import { isRecord, isUnknownArray, type UnknownRecord } from "../../shared/unknown.ts";
import { normalizeSessionInfo, type SessionInfo, type SessionSnapshot } from "../types.ts";

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

/** Multipart frames build a private cache; only a complete validated snapshot escapes. */
export class SnapshotReader {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly receipts: Receipt[] = [];

  private addSession(row: unknown): void {
    if (!isRecord(row) || typeof row.id !== "string") {
      throw new Error("Invalid session snapshot row");
    }
    const topics = optionalArray(row.topics);
    const subscriptions = optionalArray(row.subscriptions);
    const previous = this.sessions.get(row.id);
    const info = normalizeSessionInfo({
      ...previous,
      ...row,
      ...(topics !== undefined ? { topics: [...(previous?.topics ?? []), ...topics] } : {}),
      ...(subscriptions !== undefined
        ? { subscriptions: [...(previous?.subscriptions ?? []), ...subscriptions] }
        : {}),
    });
    if (!info) {
      throw new Error("Invalid session snapshot");
    }
    this.sessions.set(info.id, info);
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
    return { sessions: [...this.sessions.values()], receipts: this.receipts };
  }
}
