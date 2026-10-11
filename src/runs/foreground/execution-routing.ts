import * as path from "node:path";
import {
  resolveInheritedNestedRouteFromEnv,
  resolveNestedParentAddressFromEnv,
  type NestedRunResolutionScope,
} from "../shared/nested-events.ts";
import type { ExecutorDeps } from "./subagent-params.ts";

export const MUTATING_MANAGEMENT_ACTIONS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "delete",
]);
export function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
  return requestedCwd !== undefined && requestedCwd.length > 0
    ? path.resolve(runtimeCwd, requestedCwd)
    : runtimeCwd;
}
/** Child-safe callers may resolve only their inherited descendant route. */
export function nestedResolutionScopeForExecutor(
  deps: Readonly<Pick<ExecutorDeps, "allowMutatingManagementActions">>,
): NestedRunResolutionScope | undefined {
  if (deps.allowMutatingManagementActions !== false) {
    return;
  }
  const route = resolveInheritedNestedRouteFromEnv();
  const address = route ? resolveNestedParentAddressFromEnv() : undefined;
  return {
    routes: route ? [route] : [],
    ...(address
      ? {
          descendantOf: {
            parentRunId: address.parentRunId,
            ...(address.parentStepIndex !== undefined
              ? { parentStepIndex: address.parentStepIndex }
              : {}),
          },
        }
      : {}),
  };
}
