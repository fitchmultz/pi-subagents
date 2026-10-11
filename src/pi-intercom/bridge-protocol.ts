import { errorMessage, isRecord, type UnknownRecord } from "../shared/unknown.ts";

export const BODY_LIMIT = 64 * 1024;
export const ASK_TIMEOUT = 120000;
export const INBOX_COUNT = 256;
export const INBOX_BYTES = 4 * 1024 * 1024;

export class Fault extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: UnknownRecord;
  constructor(status: number, code: string, message: string, details: UnknownRecord = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function object(value: unknown, fields: readonly string[]): UnknownRecord {
  if (!isRecord(value)) {
    throw new Fault(400, "invalid_input", "Expected a JSON object.");
  }
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new Fault(400, "invalid_input", "Unknown field.");
  }
  return value;
}

export function label(value: unknown, field: string, max = 512): string {
  // Labels are single-line identifiers and paths; reject C0/C1 controls and DEL.
  // oxlint-disable-next-line no-control-regex
  const controls = /[\u0000-\u001f\u007f-\u009f]/;
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > max ||
    controls.test(value)
  ) {
    throw new Fault(400, "invalid_input", `Invalid ${field}.`);
  }
  return value;
}

export function text(value: unknown): string {
  // Message text permits tab/newline/CR, but rejects other C0/C1 controls and DEL.
  // oxlint-disable-next-line no-control-regex
  const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
  if (typeof value !== "string" || value.trim() === "" || controls.test(value)) {
    throw new Fault(400, "invalid_input", "Invalid message.");
  }
  return value;
}

export function fingerprint(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/.test(value)
  ) {
    throw new Fault(400, "invalid_input", "Invalid SHA256 certificate fingerprint.");
  }
  return value.replaceAll(":", "").toUpperCase();
}

export function cancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    signal.throwIfAborted();
  }
}

export function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(errorMessage(error)));
        },
      )
      .catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      });
    if (signal.aborted) {
      abort();
    }
  });
}

let logBackpressure = false;
let lostLogEvents = 0;
export function log(event: string, fields: UnknownRecord = {}): void {
  if (logBackpressure) {
    lostLogEvents = Math.min(Number.MAX_SAFE_INTEGER, lostLogEvents + 1);
    return;
  }
  logBackpressure = !process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`,
  );
  if (logBackpressure) {
    process.stdout.once("drain", () => {
      logBackpressure = false;
      if (lostLogEvents > 0) {
        const lostEvents = lostLogEvents;
        lostLogEvents = 0;
        log("log_overflow", { result: "metadata_lost", lostEvents });
      }
    });
  }
}
