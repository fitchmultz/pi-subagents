import { encodeNestedPathEnv, parseNestedPathEnv } from "./nested-path.ts";
import type { ReadonlyInput } from "../../shared/types.ts";
import type { BuildPiArgsInput } from "./pi-launch-input.ts";
import { nonempty } from "./child-json.ts";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "./structured-output.ts";

export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
export const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
export const SUBAGENT_FANOUT_CHILD_ENV = "PI_SUBAGENT_FANOUT_CHILD";
export const SUBAGENT_EAGER_TOOL_ENV = "PI_SUBAGENT_EAGER_TOOL";
export const SUBAGENT_PARENT_EVENT_SINK_ENV = "PI_SUBAGENT_PARENT_EVENT_SINK";
export const SUBAGENT_PARENT_CONTROL_INBOX_ENV = "PI_SUBAGENT_PARENT_CONTROL_INBOX";
export const SUBAGENT_PARENT_ROOT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_ROOT_RUN_ID";
export const SUBAGENT_PARENT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_RUN_ID";
export const SUBAGENT_PARENT_CHILD_INDEX_ENV = "PI_SUBAGENT_PARENT_CHILD_INDEX";
export const SUBAGENT_PARENT_DEPTH_ENV = "PI_SUBAGENT_PARENT_DEPTH";
export const SUBAGENT_PARENT_PATH_ENV = "PI_SUBAGENT_PARENT_PATH";
export const SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV = "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN";
export const SUBAGENT_INHERITED_EXTENSIONS_JSON_ENV = "PI_SUBAGENT_INHERITED_EXTENSIONS_JSON";
type LaunchInput = ReadonlyInput<BuildPiArgsInput>;

function inheritedRoute(): boolean {
  return [
    SUBAGENT_PARENT_EVENT_SINK_ENV,
    SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
    SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  ].every((key) => nonempty(process.env[key]));
}
function routeIdentity(
  input: LaunchInput,
  inherited: boolean,
): { runId: string; childIndex: string; depth: number } {
  const runId =
    input.parentRunId ??
    input.runId ??
    (inherited ? process.env[SUBAGENT_RUN_ID_ENV] : undefined) ??
    process.env[SUBAGENT_PARENT_RUN_ID_ENV] ??
    "";
  return {
    runId,
    childIndex: routeChildIndex(input),
    depth: routeDepth(input.parentDepth, inherited),
  };
}
function routeChildIndex(input: LaunchInput): string {
  const index = input.parentChildIndex ?? input.childIndex;
  return index !== undefined ? String(index) : (process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] ?? "");
}
function routeDepth(depth: number | undefined, inherited: boolean): number {
  const inheritedDepth = Number(process.env[SUBAGENT_PARENT_DEPTH_ENV]);
  return depth ?? (inherited && Number.isFinite(inheritedDepth) ? inheritedDepth + 1 : 1);
}
function routePath(input: LaunchInput, runId: string, childIndex: string): string {
  const route = input.parentPath ?? [
    ...parseNestedPathEnv(process.env[SUBAGENT_PARENT_PATH_ENV]),
    ...(nonempty(runId)
      ? [
          {
            runId,
            ...(nonempty(childIndex) && /^\d+$/.test(childIndex)
              ? { stepIndex: Number(childIndex) }
              : {}),
            ...(nonempty(input.childAgentName) ? { agent: input.childAgentName } : {}),
          },
        ]
      : []),
  ];
  return encodeNestedPathEnv(route);
}
function routeTransport(input: LaunchInput): Record<string, string> {
  return {
    [SUBAGENT_PARENT_EVENT_SINK_ENV]:
      input.parentEventSink ?? process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] ?? "",
    [SUBAGENT_PARENT_CONTROL_INBOX_ENV]:
      input.parentControlInbox ?? process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] ?? "",
    [SUBAGENT_PARENT_ROOT_RUN_ID_ENV]:
      input.parentRootRunId ?? process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] ?? input.runId ?? "",
    [SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]:
      input.parentCapabilityToken ?? process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] ?? "",
  };
}
function parentRoute(input: LaunchInput): Record<string, string> {
  const { runId, childIndex, depth } = routeIdentity(input, inheritedRoute());
  return {
    ...routeTransport(input),
    [SUBAGENT_PARENT_RUN_ID_ENV]: runId,
    [SUBAGENT_PARENT_CHILD_INDEX_ENV]: childIndex,
    [SUBAGENT_PARENT_DEPTH_ENV]: String(depth),
    [SUBAGENT_PARENT_PATH_ENV]: routePath(input, runId, childIndex),
  };
}
function childIdentity(input: LaunchInput): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of [
    ["PI_SUBAGENT_INTERCOM_SESSION_NAME", input.intercomSessionName],
    [SUBAGENT_ORCHESTRATOR_TARGET_ENV, input.orchestratorIntercomTarget],
    [SUBAGENT_RUN_ID_ENV, input.runId],
    [SUBAGENT_CHILD_AGENT_ENV, input.childAgentName],
  ]) {
    if (nonempty(key) && nonempty(value)) {
      env[key] = value;
    }
  }
  if (input.childIndex !== undefined) {
    env[SUBAGENT_CHILD_INDEX_ENV] = String(input.childIndex);
  }
  if ((input.mcpDirectTools?.length ?? 0) > 0) {
    env.MCP_DIRECT_TOOLS = input.mcpDirectTools?.join(",");
  }
  return env;
}

/** A non-fanout child explicitly clears inherited routes and its parent's capture. */
export function childRouteEnv(
  input: LaunchInput,
  fanoutAuthorized: boolean,
): Record<string, string | undefined> {
  const route = parentRoute(input);
  return {
    ...Object.fromEntries(
      Object.entries(route).map(([key, value]) => [key, fanoutAuthorized ? value : ""]),
    ),
    ...childIdentity(input),
    [SUBAGENT_CHILD_ENV]: "1",
    PI_SUBAGENT_ROOT_SESSION_ID:
      input.rootSessionId ??
      (process.env[SUBAGENT_CHILD_ENV] === "1"
        ? process.env.PI_SUBAGENT_ROOT_SESSION_ID
        : undefined),
    [SUBAGENT_FANOUT_CHILD_ENV]: fanoutAuthorized ? "1" : "0",
    PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: input.inheritProjectContext ? "1" : "0",
    PI_SUBAGENT_INHERIT_SKILLS: input.inheritSkills ? "1" : "0",
    [STRUCTURED_OUTPUT_CAPTURE_ENV]: input.structuredOutput?.outputPath ?? "",
    [STRUCTURED_OUTPUT_SCHEMA_ENV]: input.structuredOutput?.schemaPath ?? "",
  };
}
