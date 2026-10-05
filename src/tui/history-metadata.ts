import type {
  AssistantMessage,
  DeferredHandle,
  NestedToolCalls,
  NestedToolCallRecord,
  Usage,
} from "@earendil-works/pi-ai";
import { Type, Check } from "../shared/native-typebox.ts";
import { isJson, isJsonObject } from "./history-json.ts";
const cost = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  total: Type.Number(),
});
export const usageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  totalTokens: Type.Number(),
  cost,
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
});
export function nativeUsage(value: unknown): Usage | undefined {
  return Check(usageSchema, value) ? { ...value, cost: { ...value.cost } } : undefined;
}
const nestedCallFields = Type.Object({
  id: Type.String(),
  name: Type.String(),
  arguments: Type.Optional(Type.Unknown()),
  argumentsBytes: Type.Optional(Type.Number()),
  status: Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("unfinished")]),
  durationMs: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
});
function nestedCall(value: unknown): NestedToolCallRecord | undefined {
  if (!Check(nestedCallFields, value)) {
    return;
  }
  const args = value.arguments;
  if (args !== undefined && !isJsonObject(args)) {
    return;
  }
  return { ...value, arguments: args };
}
const nestedCallsFields = Type.Object({
  calls: Type.Array(Type.Unknown()),
  complete: Type.Boolean(),
});
export function nativeNestedCalls(value: unknown): NestedToolCalls | undefined {
  if (!Check(nestedCallsFields, value)) {
    return;
  }
  const calls: NestedToolCallRecord[] = [];
  for (const part of value.calls) {
    const call = nestedCall(part);
    if (!call) {
      return;
    }
    calls.push(call);
  }
  return { calls, complete: value.complete };
}
const deferredFields = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  api: Type.String(),
  id: Type.String(),
  expiresAt: Type.Optional(Type.Number()),
  pollAfterMs: Type.Optional(Type.Number()),
  data: Type.Optional(Type.Unknown()),
});
function deferred(value: unknown): DeferredHandle | undefined {
  if (!Check(deferredFields, value)) {
    return;
  }
  const data = value.data;
  if (data !== undefined && !isJson(data)) {
    return;
  }
  return { ...value, data };
}
const diagnosticFields = Type.Object({
  type: Type.String(),
  timestamp: Type.Number(),
  error: Type.Optional(
    Type.Object({
      name: Type.Optional(Type.String()),
      message: Type.String(),
      stack: Type.Optional(Type.String()),
      code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    }),
  ),
  details: Type.Optional(Type.Unknown()),
});
type Diagnostic = NonNullable<AssistantMessage["diagnostics"]>[number];
function diagnostic(value: unknown): Diagnostic | undefined {
  if (!Check(diagnosticFields, value)) {
    return;
  }
  const details = value.details;
  if (details !== undefined && !isJsonObject(details)) {
    return;
  }
  return { ...value, details };
}
function diagnostics(value: unknown): Diagnostic[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const parsed: Diagnostic[] = [];
  for (const part of value) {
    const item = diagnostic(part);
    if (!item) {
      return;
    }
    parsed.push(item);
  }
  return parsed;
}
const metadataFields = Type.Object({
  responseModel: Type.Optional(Type.String()),
  responseId: Type.Optional(Type.String()),
  providerThinkingLevel: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
    ]),
  ),
  rawStopReason: Type.Optional(Type.String()),
  endTurn: Type.Optional(Type.Boolean()),
});
type Metadata = Pick<
  AssistantMessage,
  | "responseModel"
  | "responseId"
  | "providerThinkingLevel"
  | "thinkingLevel"
  | "rawStopReason"
  | "endTurn"
  | "deferred"
  | "diagnostics"
>;
export function assistantMetadata(value: Readonly<Record<string, unknown>>): Metadata | undefined {
  const pending = value.deferred,
    notes = value.diagnostics;
  const deferredValue = pending === undefined ? undefined : deferred(pending),
    diagnosticValues = notes === undefined ? undefined : diagnostics(notes);
  if (
    (pending !== undefined && deferredValue === undefined) ||
    (notes !== undefined && diagnosticValues === undefined) ||
    !Check(metadataFields, value)
  ) {
    return;
  }
  return {
    responseModel: value.responseModel,
    responseId: value.responseId,
    providerThinkingLevel: value.providerThinkingLevel,
    thinkingLevel: value.thinkingLevel,
    rawStopReason: value.rawStopReason,
    endTurn: value.endTurn,
    deferred: deferredValue,
    diagnostics: diagnosticValues,
  };
}
