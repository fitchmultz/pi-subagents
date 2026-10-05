import { Ajv } from "ajv";
import statusSchema from "./schemas/AsyncStatus.json" with { type: "json" };
import resultSchema from "./schemas/AsyncResultFile.json" with { type: "json" };
import foregroundSchema from "./schemas/ForegroundResumeRun.json" with { type: "json" };
import ownedSchema from "./schemas/OwnedRun.json" with { type: "json" };
import type { AsyncStatus, AsyncResultFile, ForegroundResumeRun, OwnedRun } from "../../shared/types.ts";

// Typed guards are compiled from generated canonical declarations, not assertion casts.
// Unknown forward-compatible properties remain permitted; declared nested fields are checked.
const validator = new Ajv({ strict: false, allErrors: true, strictNumbers: true });
const status = validator.compile<AsyncStatus>(statusSchema);
const result = validator.compile<AsyncResultFile>(resultSchema);
const foreground = validator.compile<ForegroundResumeRun>(foregroundSchema);
const owned = validator.compile<OwnedRun>(ownedSchema);

export function parseAsyncStatus(value: unknown): AsyncStatus {
  if (!status(value)) {
    throw new Error(`Invalid async status: ${validator.errorsText(status.errors)}.`);
  }
  return value;
}

export function parseAsyncResult(value: unknown): AsyncResultFile {
  if (!result(value)) {
    throw new Error(`Invalid async result: ${validator.errorsText(result.errors)}.`);
  }
  return value;
}

export function parseForegroundResumeRun(value: unknown): ForegroundResumeRun {
  if (!foreground(value)) {
    throw new Error(`Invalid foreground run: ${validator.errorsText(foreground.errors)}.`);
  }
  return value;
}

export function parseOwnedRun(value: unknown): OwnedRun {
  if (!owned(value)) {
    throw new Error(`Invalid owned run: ${validator.errorsText(owned.errors)}.`);
  }
  return value;
}
