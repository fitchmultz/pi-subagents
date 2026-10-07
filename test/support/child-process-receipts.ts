import assert from "node:assert/strict";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { readJson } from "./assertions.ts";

const environment = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));
const childCall = Compile(
  Type.Object({
    args: Type.Array(Type.String()),
    expandedArgs: Type.Array(Type.String()),
    cwd: Type.String(),
    env: Type.Optional(environment),
    sessionCwd: Type.Optional(Type.Object({ cwd: Type.Optional(Type.String()) })),
  }),
);
const claudeCall = Compile(
  Type.Object({
    args: Type.Array(Type.String()),
    env: environment,
  }),
);
const nativeAttemptReceipt = Compile(
  Type.Object({
    pid: Type.Integer(),
    calls: Type.Integer(),
    networkRequests: Type.Integer(),
    errors: Type.Array(Type.String()),
    tools: Type.Array(Type.Array(Type.String())),
    sampling: Type.Array(Type.Unknown()),
    shutdownStarted: Type.Boolean(),
    shutdownFinished: Type.Boolean(),
    events: Type.Array(Type.Unknown()),
    sawStagedFailure: Type.Optional(Type.Boolean()),
  }),
);
const nativeReportReceipt = Compile(
  Type.Object({
    scenario: Type.String(),
    sdkRoot: Type.String(),
    providerCalls: Type.Integer(),
    providerCwds: Type.Array(Type.String()),
    networkRequests: Type.Integer(),
    extensionErrors: Type.Array(Type.Unknown()),
    events: Type.Array(
      Type.Object({
        type: Type.String(),
        isError: Type.Optional(Type.Boolean()),
      }),
    ),
    messages: Type.Array(
      Type.Object({
        role: Type.String(),
        content: Type.Unknown(),
        toolCallId: Type.Optional(Type.String()),
        isError: Type.Optional(Type.Boolean()),
      }),
    ),
    schema: Type.Optional(Type.Object({ required: Type.Optional(Type.Array(Type.String())) })),
    capture: Type.Optional(Type.Unknown()),
    waiting: Type.Optional(Type.Boolean()),
    sessionFile: Type.Optional(Type.String()),
  }),
);

/** Validate actual child-process publications, never synthesize receipt fields. */
export function readChildCall(file: string): ReturnType<typeof childCall.Parse> {
  const value = readJson(file);
  assert.ok(childCall.Check(value), `Invalid child call receipt: ${file}`);
  return value;
}
export function readClaudeCall(file: string): ReturnType<typeof claudeCall.Parse> {
  const value = readJson(file);
  assert.ok(claudeCall.Check(value), `Invalid Claude call receipt: ${file}`);
  return value;
}
export function readNativeAttemptReceipt(
  file: string,
): ReturnType<typeof nativeAttemptReceipt.Parse> {
  const value = readJson(file);
  assert.ok(nativeAttemptReceipt.Check(value), `Invalid native attempt receipt: ${file}`);
  return value;
}
export function readNativeReportReceipt(
  file: string,
): ReturnType<typeof nativeReportReceipt.Parse> {
  const value = readJson(file);
  assert.ok(nativeReportReceipt.Check(value), `Invalid native report receipt: ${file}`);
  return value;
}
