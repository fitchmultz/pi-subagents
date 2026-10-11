import {
  assertSafeNestedId as assertSafeId,
  isSafeNestedId,
  type NestedRoute,
  type NestedEventRecord,
  type NestedControlRequestRecord,
  type NestedControlResultRecord,
} from "./nested-protocol.ts";
import { validateRouteShape, readRouteFiles, writeRouteRecord } from "./nested-route.ts";
import { clampNumber, stringValue, parseRecord, parseRouteRecord } from "./nested-validation.ts";

export function writeNestedEvent(
  route: NestedRoute,
  event: Omit<NestedEventRecord, "rootRunId" | "capabilityToken">,
): void {
  validateRouteShape(route);
  const record: NestedEventRecord = {
    ...event,
    rootRunId: route.rootRunId,
    capabilityToken: route.capabilityToken,
  };
  const sanitized = parseRecord(JSON.stringify(record), route);
  if (!sanitized) {
    throw new Error("Nested event record failed validation.");
  }
  writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}

function controlAddress(
  raw: Readonly<Record<string, unknown>>,
): { readonly requestId: string; readonly targetRunId: string; readonly ts: number } | undefined {
  const ts = clampNumber(raw.ts);
  if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId) || ts === undefined) {
    return;
  }
  return { requestId: raw.requestId, targetRunId: raw.targetRunId, ts };
}

function validIndex(value: unknown, safe: boolean): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    typeof value === "number" &&
    value >= 0 &&
    (safe ? Number.isSafeInteger(value) : Number.isInteger(value))
  );
}

function requestIndices(
  raw: Readonly<Record<string, unknown>>,
): Pick<NestedControlRequestRecord, "index" | "targetChildIndex"> | undefined {
  if (!validIndex(raw.targetChildIndex, false) || !validIndex(raw.index, true)) {
    return;
  }
  return {
    ...(typeof raw.targetChildIndex === "number" ? { targetChildIndex: raw.targetChildIndex } : {}),
    ...(typeof raw.index === "number" ? { index: raw.index } : {}),
  };
}

function parseControlRequest(
  content: string,
  route: NestedRoute,
): NestedControlRequestRecord | undefined {
  const raw = parseRouteRecord(content, route);
  if (!raw || raw.type !== "subagent.nested.control-request") {
    return;
  }
  const address = controlAddress(raw);
  const indices = requestIndices(raw);
  if (!address || !indices) {
    return;
  }
  if (raw.action !== "interrupt" && raw.action !== "resume") {
    return;
  }
  const message = stringValue(raw.message, 16_000);
  return {
    type: "subagent.nested.control-request",
    ...address,
    ...indices,
    rootRunId: route.rootRunId,
    capabilityToken: route.capabilityToken,
    action: raw.action,
    ...(message !== undefined ? { message } : {}),
  };
}

function parseControlResult(
  content: string,
  route: NestedRoute,
): NestedControlResultRecord | undefined {
  const raw = parseRouteRecord(content, route);
  if (!raw || raw.type !== "subagent.nested.control-result") {
    return;
  }
  const address = controlAddress(raw);
  if (!address || typeof raw.ok !== "boolean") {
    return;
  }
  return {
    type: "subagent.nested.control-result",
    ...address,
    rootRunId: route.rootRunId,
    capabilityToken: route.capabilityToken,
    ok: raw.ok,
    message:
      stringValue(raw.message, 16_000) ??
      (raw.ok ? "Control request completed." : "Control request failed."),
  };
}

export function writeNestedControlRequest(
  route: NestedRoute,
  request: Omit<NestedControlRequestRecord, "type" | "rootRunId" | "capabilityToken">,
): string {
  validateRouteShape(route);
  assertSafeId("requestId", request.requestId);
  assertSafeId("targetRunId", request.targetRunId);
  const record: NestedControlRequestRecord = {
    type: "subagent.nested.control-request",
    ...request,
    rootRunId: route.rootRunId,
    capabilityToken: route.capabilityToken,
  };
  const sanitized = parseControlRequest(JSON.stringify(record), route);
  if (!sanitized) {
    throw new Error("Nested control request failed validation.");
  }
  return writeRouteRecord(route.controlInbox, sanitized.ts, sanitized);
}

export function readNestedControlRequests(
  route: NestedRoute,
  skipFiles: Readonly<ReadonlySet<string>> = new Set(),
): Array<NestedControlRequestRecord & { filePath: string }> {
  validateRouteShape(route);
  return readRouteFiles(
    route.controlInbox,
    (entry) => entry.endsWith(".json") && !skipFiles.has(entry),
  ).flatMap(({ filePath, content }) => {
    const request = parseControlRequest(content, route);
    return request ? [{ ...request, filePath }] : [];
  });
}

export function writeNestedControlResult(
  route: NestedRoute,
  result: Omit<NestedControlResultRecord, "type" | "rootRunId" | "capabilityToken">,
): void {
  validateRouteShape(route);
  assertSafeId("requestId", result.requestId);
  assertSafeId("targetRunId", result.targetRunId);
  const record: NestedControlResultRecord = {
    type: "subagent.nested.control-result",
    ...result,
    rootRunId: route.rootRunId,
    capabilityToken: route.capabilityToken,
  };
  const sanitized = parseControlResult(JSON.stringify(record), route);
  if (!sanitized) {
    throw new Error("Nested control result failed validation.");
  }
  writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}

export function readNestedControlResults(route: NestedRoute): NestedControlResultRecord[] {
  validateRouteShape(route);
  return readRouteFiles(
    route.eventSink,
    (entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"),
  ).flatMap(({ content }) =>
    (content.includes("\n") ? content.split("\n").filter((line) => line.trim() !== "") : [content])
      .map((line) => parseControlResult(line, route))
      .filter((result): result is NestedControlResultRecord => Boolean(result)),
  );
}
