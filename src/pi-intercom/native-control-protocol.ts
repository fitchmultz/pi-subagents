import { isRecord, isUnknownArray } from "../shared/unknown.ts";
import type { TranscriptOptions, TranscriptPage } from "./transcript.ts";

export const CONTROL_SCHEMA = "pi-intercom/control-v1";
export const CONTROL_FALLBACK =
  "Native Intercom metadata exchange (no conversation response needed).";
export type NativeControlVerb = "capabilities" | "cancel" | "stop" | "transcript";
export interface NativeControlOperation {
  readonly to: string;
  readonly verb: NativeControlVerb;
  readonly options?: TranscriptOptions;
  readonly timeoutMs: number;
}
export interface NativeControlRequest {
  readonly schema: typeof CONTROL_SCHEMA;
  readonly kind: "request";
  readonly verb: NativeControlVerb;
  /** Public TLS certificate, supplied by the bridge, never a caller-selected identity. */
  readonly certificate: string;
  readonly options?: TranscriptOptions;
}
export interface NativeControlResult {
  readonly schema: typeof CONTROL_SCHEMA;
  readonly kind: "result";
  readonly verb: NativeControlVerb;
  readonly status:
    | "ok"
    | "denied"
    | "cancel_requested"
    | "shutdown_requested"
    | "unsupported"
    | "failed";
  readonly verbs?: readonly NativeControlVerb[];
  readonly mode?: string;
  readonly idle?: boolean;
  readonly pendingInput?: boolean;
  readonly queueCleared?: false;
  readonly processExited?: false;
  readonly stopSupport?: "native_shutdown" | "requires_activity" | "host_dependent";
  readonly reason?: string;
  readonly transcript?: TranscriptPage;
}
export type NativeControlEnvelope = NativeControlRequest | NativeControlResult;

export function isControlVerb(value: unknown): value is NativeControlVerb {
  return (
    value === "capabilities" || value === "cancel" || value === "stop" || value === "transcript"
  );
}
export function isControlRequest(value: unknown): value is NativeControlRequest {
  return (
    isRecord(value) &&
    value.schema === CONTROL_SCHEMA &&
    value.kind === "request" &&
    isControlVerb(value.verb) &&
    typeof value.certificate === "string" &&
    value.certificate.length <= 16384 &&
    Object.keys(value).every((key) =>
      ["schema", "kind", "verb", "certificate", "options"].includes(key),
    )
  );
}
export function isControlResult(value: unknown): value is NativeControlResult {
  if (
    !isRecord(value) ||
    value.schema !== CONTROL_SCHEMA ||
    value.kind !== "result" ||
    !isControlVerb(value.verb)
  ) {
    return false;
  }
  return (
    validResultFields(value) &&
    validResultPayload(value) &&
    Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024
  );
}
function optionalText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}
function validResultFields(value: Readonly<Record<string, unknown>>): boolean {
  const fields = new Set([
    "schema",
    "kind",
    "verb",
    "status",
    "mode",
    "idle",
    "pendingInput",
    "queueCleared",
    "processExited",
    "stopSupport",
    "reason",
    "transcript",
    "verbs",
  ]);
  return (
    Object.keys(value).every((key) => fields.has(key)) &&
    typeof value.status === "string" &&
    ["ok", "denied", "cancel_requested", "shutdown_requested", "unsupported", "failed"].includes(
      value.status,
    ) &&
    optionalText(value.reason, 2048) &&
    optionalText(value.mode, 64) &&
    [value.idle, value.pendingInput].every(
      (flag) => flag === undefined || typeof flag === "boolean",
    ) &&
    [value.queueCleared, value.processExited].every((flag) => flag === undefined || flag === false)
  );
}
function validResultPayload(value: Readonly<Record<string, unknown>>): boolean {
  if (
    value.stopSupport !== undefined &&
    (typeof value.stopSupport !== "string" ||
      !["native_shutdown", "requires_activity", "host_dependent"].includes(value.stopSupport))
  ) {
    return false;
  }
  if (
    value.verbs !== undefined &&
    (!isUnknownArray(value.verbs) || !value.verbs.every(isControlVerb))
  ) {
    return false;
  }
  return value.transcript === undefined || validTranscript(value.transcript);
}
function validTranscript(value: unknown): boolean {
  if (!isRecord(value) || !isUnknownArray(value.records) || value.records.length > 100) {
    return false;
  }
  const fields = new Set([
    "sessionId",
    "leafId",
    "records",
    "bytes",
    "truncated",
    "cursor",
    "scanLimitReached",
    "finalizedOnly",
    "streaming",
  ]);
  return (
    Object.keys(value).every((key) => fields.has(key)) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length <= 512 &&
    (value.leafId === null || typeof value.leafId === "string") &&
    value.records.every(validTranscriptRecord) &&
    validTranscriptMetadata(value)
  );
}
function validTranscriptMetadata(value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value.bytes === "number" &&
    Number.isInteger(value.bytes) &&
    value.bytes >= 0 &&
    value.bytes <= 131072 &&
    typeof value.truncated === "boolean" &&
    optionalText(value.cursor, 512) &&
    typeof value.scanLimitReached === "boolean" &&
    value.finalizedOnly === true &&
    value.streaming === "unavailable"
  );
}
function validTranscriptRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const fields = new Set(["id", "timestamp", "role", "text", "truncated"]);
  return (
    Object.keys(value).every((key) => fields.has(key)) &&
    [value.id, value.timestamp].every(
      (field) => typeof field === "string" && field.length <= 512,
    ) &&
    typeof value.role === "string" &&
    ["user", "assistant", "toolResult", "custom"].includes(value.role) &&
    typeof value.text === "string" &&
    Buffer.byteLength(value.text) <= 131072 &&
    typeof value.truncated === "boolean"
  );
}
