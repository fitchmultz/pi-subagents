import * as fs from "node:fs";
import * as path from "node:path";
import type { NestedRunSummary, NestedRunState } from "../../shared/types.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
  assertSafeNestedId as assertSafeId,
  type NestedRoute,
  type NestedRegistry,
  type NestedEventRecord,
  MAX_CHILDREN,
  REGISTRY_FILE,
} from "./nested-protocol.ts";
import {
  commonRouteRoot,
  validateRouteShape,
  listNestedRoutes,
  readRouteFiles,
} from "./nested-route.ts";
import { parseNestedEventRecords, sanitizeSummary } from "./nested-validation.ts";

export function terminal(state: NestedRunState): boolean {
  return state === "complete" || state === "failed" || state === "blocked" || state === "paused";
}

function mergeSummary(
  existing: NestedRunSummary | undefined,
  event: NestedEventRecord,
): NestedRunSummary {
  const incomingState =
    event.type === "subagent.nested.completed" && event.child.state === "running"
      ? "complete"
      : event.child.state;
  const incoming = {
    ...event.child,
    state: incomingState,
    lastUpdate: event.child.lastUpdate ?? event.ts,
  };
  if (!existing) {
    return incoming;
  }
  const existingUpdate = existing.lastUpdate ?? 0;
  const incomingUpdate = incoming.lastUpdate ?? event.ts;
  if (incomingUpdate < existingUpdate) {
    return existing;
  }
  if (terminal(existing.state) && !terminal(incoming.state)) {
    return existing;
  }
  if (terminal(existing.state) && terminal(incoming.state) && incomingUpdate === existingUpdate) {
    return existing;
  }
  return {
    ...existing,
    ...incoming,
    state: incoming.state,
    lastUpdate: Math.max(existingUpdate, incomingUpdate),
  };
}

function attachChild(
  children: readonly NestedRunSummary[],
  event: NestedEventRecord,
): NestedRunSummary[] {
  let updated = false;
  const walk = (items: readonly NestedRunSummary[]): NestedRunSummary[] =>
    items.map((item) => {
      if (item.id === event.parentRunId) {
        const existingChildren = item.children ?? [];
        const childIndex = existingChildren.findIndex((child) => child.id === event.child.id);
        const nextChild = mergeSummary(
          childIndex >= 0 ? existingChildren[childIndex] : undefined,
          event,
        );
        const nextChildren =
          childIndex >= 0
            ? existingChildren.map((child, index) => (index === childIndex ? nextChild : child))
            : [...existingChildren, nextChild];
        updated = true;
        return {
          ...item,
          children: nextChildren.slice(0, MAX_CHILDREN),
          lastUpdate: Math.max(item.lastUpdate ?? 0, event.ts),
        };
      }
      if ((item.children?.length ?? 0) === 0) {
        return item;
      }
      const nextChildren = walk(item.children ?? []);
      return nextChildren === item.children ? item : { ...item, children: nextChildren };
    });
  const next = walk(children);
  if (updated) {
    return next;
  }
  const childIndex = next.findIndex((child) => child.id === event.child.id);
  const nextChild = mergeSummary(childIndex >= 0 ? next[childIndex] : undefined, event);
  return childIndex >= 0
    ? next.map((child, index) => (index === childIndex ? nextChild : child))
    : [...next, nextChild].slice(0, MAX_CHILDREN);
}

export function applyNestedEvent(
  registry: NestedRegistry,
  event: NestedEventRecord,
): NestedRegistry {
  return {
    ...registry,
    updatedAt: Math.max(registry.updatedAt, event.ts),
    children: attachChild(registry.children, event),
  };
}

function registryPath(route: NestedRoute): string {
  return path.join(commonRouteRoot(route), REGISTRY_FILE);
}

export function findNestedRouteForRootId(rootRunId: string): NestedRoute | undefined {
  assertSafeId("rootRunId", rootRunId);
  return listNestedRoutes(rootRunId)[0];
}

export function projectNestedRegistryForRoot(rootRunId: string): NestedRegistry | undefined {
  const route = findNestedRouteForRootId(rootRunId);
  return route ? projectNestedEvents(route) : undefined;
}

export function findNestedRun(
  children: readonly NestedRunSummary[] | undefined,
  id: string,
): NestedRunSummary | undefined {
  if (children === undefined || children.length === 0) {
    return undefined;
  }
  for (const child of children) {
    if (child.id === id) {
      return child;
    }
    const nested =
      findNestedRun(child.children, id) ??
      findNestedRun(
        child.steps?.flatMap((step) => step.children ?? []),
        id,
      );
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export interface NestedRunMatch {
  rootRunId: string;
  route: NestedRoute;
  run: NestedRunSummary;
}

export interface NestedRunResolutionScope {
  routes: NestedRoute[];
  descendantOf?: { parentRunId: string; parentStepIndex?: number };
}

function collectNestedRuns(
  children: readonly NestedRunSummary[] | undefined,
  output: NestedRunSummary[] = [],
): NestedRunSummary[] {
  for (const child of children ?? []) {
    output.push(child);
    collectNestedRuns(child.children, output);
    collectNestedRuns(
      child.steps?.flatMap((step) => step.children ?? []),
      output,
    );
  }
  return output;
}

function collectScopedNestedRuns(
  children: readonly NestedRunSummary[] | undefined,
  scope: NestedRunResolutionScope["descendantOf"],
  output: NestedRunSummary[] = [],
): NestedRunSummary[] {
  if (!scope) {
    return collectNestedRuns(children, output);
  }
  for (const child of children ?? []) {
    if (
      child.parentRunId === scope.parentRunId &&
      (scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)
    ) {
      collectNestedRuns([child], output);
      continue;
    }
    collectScopedNestedRuns(child.children, scope, output);
    collectScopedNestedRuns(
      child.steps?.flatMap((step) => step.children ?? []),
      scope,
      output,
    );
  }
  return output;
}

export function findNestedRunMatchesById(
  id: string,
  options: { prefix?: boolean; scope?: NestedRunResolutionScope } = {},
): NestedRunMatch[] {
  assertSafeId("id", id);
  const matches: NestedRunMatch[] = [];
  for (const route of options.scope?.routes ?? listNestedRoutes()) {
    try {
      const registry = projectNestedEvents(route);
      for (const run of collectScopedNestedRuns(registry.children, options.scope?.descendantOf)) {
        if (options.prefix === true ? run.id.startsWith(id) : run.id === id) {
          matches.push({ rootRunId: route.rootRunId, route, run });
        }
      }
    } catch {
      continue;
    }
  }
  return matches;
}

export function readNestedRegistry(route: NestedRoute): NestedRegistry {
  validateRouteShape(route);
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(route), "utf-8")) as NestedRegistry;
    return {
      rootRunId: route.rootRunId,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      children: Array.isArray(parsed.children)
        ? parsed.children
            .map((child) => sanitizeSummary(child))
            .filter((child): child is NestedRunSummary => Boolean(child))
        : [],
      processedEvents: Array.isArray(parsed.processedEvents)
        ? parsed.processedEvents.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { rootRunId: route.rootRunId, updatedAt: 0, children: [], processedEvents: [] };
  }
}

export function projectNestedEvents(route: NestedRoute): NestedRegistry {
  validateRouteShape(route);
  let registry = readNestedRegistry(route);
  const seen = new Set(registry.processedEvents);
  let changed = false;
  for (const { entry, content } of readRouteFiles(
    route.eventSink,
    (name) => !seen.has(name) && (name.endsWith(".json") || name.endsWith(".jsonl")),
  )) {
    for (const event of parseNestedEventRecords(content, route)) {
      registry = applyNestedEvent(registry, event);
      changed = true;
    }
    seen.add(entry);
    changed = true;
  }
  if (changed) {
    // ponytail: directory enumeration and durable IDs still grow with route history.
    // Archive immutable files with an atomic registry checkpoint if that becomes costly.
    registry = { ...registry, processedEvents: [...seen] };
    // Parent projection is the only writer to this sidecar registry. Child and
    // runner processes only create immutable event files, so parent status.json
    // remains owned by the existing runner writer and is never rewritten here.
    writeAtomicJson(registryPath(route), registry);
  }
  return registry;
}
