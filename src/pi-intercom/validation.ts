/** JSON objects are untrusted at the broker and journal boundaries. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error === null) {
    return "null";
  }
  switch (typeof error) {
    case "string":
      return error;
    case "undefined":
      return "undefined";
    case "boolean":
    case "number":
    case "bigint":
    case "symbol":
      return String(error);
    case "object":
    case "function":
      // Do not inspect arbitrary thrown objects: they can contain private state.
      return Object.prototype.toString.call(error);
    default:
      return "Unknown error";
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

// Protocol text permits line feeds and tabs, but rejects other C0/C1 controls.
// oxlint-disable-next-line no-control-regex
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// Protocol labels are single-line fields and reject every C0/C1 control.
// oxlint-disable-next-line no-control-regex
const UNSAFE_LABEL_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;

export function safeText(value: unknown): boolean {
  return typeof value === "string" && !UNSAFE_TEXT_CONTROLS.test(value);
}

export function safeLabel(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && !UNSAFE_LABEL_CONTROLS.test(value);
}

export function optionalLabel(value: unknown): boolean {
  return value === undefined || safeLabel(value);
}

export function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || finiteNumber(value);
}
