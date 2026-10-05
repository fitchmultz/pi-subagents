import * as path from "node:path";
import { TEMP_ROOT_DIR, type NestedRouteInfo, type NestedRunSummary } from "../../shared/types.ts";
import { isSafeNestedPathId } from "./nested-path.ts";

export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
export const ROUTE_FILE = "route.json";
export const REGISTRY_FILE = "registry.json";
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_STEPS = 12;
export const MAX_CHILDREN = 16;
export const MAX_DEPTH = 3;
export type NestedRoute = NestedRouteInfo;

export interface NestedEventRecord {
  readonly type:
    | "subagent.nested.started"
    | "subagent.nested.updated"
    | "subagent.nested.completed";
  readonly ts: number;
  readonly rootRunId: string;
  readonly parentRunId: string;
  readonly parentStepIndex?: number;
  readonly capabilityToken: string;
  readonly child: NestedRunSummary;
}

export interface NestedControlResultRecord {
  readonly type: "subagent.nested.control-result";
  readonly ts: number;
  readonly rootRunId: string;
  readonly capabilityToken: string;
  readonly requestId: string;
  readonly targetRunId: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface NestedControlRequestRecord {
  readonly type: "subagent.nested.control-request";
  readonly ts: number;
  readonly rootRunId: string;
  readonly capabilityToken: string;
  readonly requestId: string;
  readonly targetRunId: string;
  readonly targetChildIndex?: number;
  /** Child inside the target run; targetChildIndex selects the outer owner. */
  readonly index?: number;
  readonly action: "interrupt" | "resume";
  readonly message?: string;
}

export interface NestedRegistry {
  readonly rootRunId: string;
  readonly updatedAt: number;
  readonly children: readonly NestedRunSummary[];
  readonly processedEvents: readonly string[];
}

export function isSafeNestedId(value: unknown): value is string {
  return isSafeNestedPathId(value);
}

export function assertSafeNestedId(label: string, value: unknown): void {
  if (!isSafeNestedId(value)) {
    throw new Error(`${label} must be a non-empty safe id token.`);
  }
}
