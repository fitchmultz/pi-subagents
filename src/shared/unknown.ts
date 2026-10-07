/** JSON and caught failures cross the process/filesystem boundary as unknown values. */
export type UnknownRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function recordAt(value: unknown, key: string | number): UnknownRecord | undefined {
  let child: unknown;
  if (isRecord(value)) {
    child = value[key];
  } else if (isUnknownArray(value) && typeof key === "number") {
    child = value[key];
  }
  return isRecord(child) ? child : undefined;
}

export function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    if (error === undefined) {
      return "undefined";
    }
    if (
      typeof error === "number" ||
      typeof error === "boolean" ||
      typeof error === "bigint" ||
      typeof error === "symbol"
    ) {
      return String(error);
    }
    const serialized: string | undefined = JSON.stringify(error);
    return typeof serialized === "string" ? serialized : "Unserializable failure";
  } catch {
    return "Unserializable failure";
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** Retain native error names without letting a broken stringifier replace the caught failure. */
export function errorDescription(error: unknown): string {
  try {
    return error instanceof Error ? error.toString() : errorMessage(error);
  } catch {
    return errorMessage(error);
  }
}
