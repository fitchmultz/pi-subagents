import * as fs from "node:fs";
import * as path from "node:path";
import type { NestedRunSummary, NestedRunState } from "../../shared/types.ts";
import { isRecord, isUnknownArray, hasErrorCode } from "../../shared/unknown.ts";
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

function rejectsSummaryUpdate(existing: NestedRunSummary, incoming: NestedRunSummary): boolean {
  const previous = existing.lastUpdate ?? 0;
  const next = incoming.lastUpdate ?? 0;
  return (
    next < previous ||
    (terminal(existing.state) && !terminal(incoming.state)) ||
    (terminal(existing.state) && terminal(incoming.state) && next === previous)
  );
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
  if (rejectsSummaryUpdate(existing, incoming)) {
    return existing;
  }
  return {
    ...existing,
    ...incoming,
    state: incoming.state,
    lastUpdate: Math.max(existing.lastUpdate ?? 0, incoming.lastUpdate),
  };
}

function mergeChild(
  items: readonly NestedRunSummary[],
  event: NestedEventRecord,
): NestedRunSummary[] {
  const index = items.findIndex((child) => child.id === event.child.id);
  const child = mergeSummary(index < 0 ? undefined : items.at(index), event);
  return index < 0
    ? [...items, child].slice(0, MAX_CHILDREN)
    : items.map((existing, position) => (position === index ? child : existing));
}

/** An event owns one tree traversal and the fact that its parent was found. */
class NestedEventAttachment {
  private matched = false;
  private readonly event: NestedEventRecord;
  constructor(event: NestedEventRecord) {
    this.event = event;
  }
  attach(children: readonly NestedRunSummary[]): NestedRunSummary[] {
    const next = this.walk(children);
    return this.matched ? next : mergeChild(next, this.event);
  }
  private walk(items: readonly NestedRunSummary[]): NestedRunSummary[] {
    return items.map((item) => this.attachItem(item));
  }
  private attachItem(item: NestedRunSummary): NestedRunSummary {
    if (item.id === this.event.parentRunId) {
      this.matched = true;
      return {
        ...item,
        children: mergeChild(item.children ?? [], this.event).slice(0, MAX_CHILDREN),
        lastUpdate: Math.max(item.lastUpdate ?? 0, this.event.ts),
      };
    }
    if ((item.children?.length ?? 0) === 0) {
      return item;
    }
    return { ...item, children: this.walk(item.children ?? []) };
  }
}

export function applyNestedEvent(
  registry: NestedRegistry,
  event: NestedEventRecord,
): NestedRegistry {
  return {
    ...registry,
    updatedAt: Math.max(registry.updatedAt, event.ts),
    children: new NestedEventAttachment(event).attach(registry.children),
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
  readonly rootRunId: string;
  readonly route: NestedRoute;
  readonly run: NestedRunSummary;
}

export interface NestedRunResolutionScope {
  readonly routes: readonly NestedRoute[];
  readonly descendantOf?: { readonly parentRunId: string; readonly parentStepIndex?: number };
}

function collectNestedRuns(children: readonly NestedRunSummary[] | undefined): NestedRunSummary[] {
  return (children ?? []).flatMap((child) =>
    [child].concat(
      collectNestedRuns(child.children),
      collectNestedRuns(child.steps?.flatMap((step) => step.children ?? [])),
    ),
  );
}
function collectScopedNestedRuns(
  children: readonly NestedRunSummary[] | undefined,
  scope: NestedRunResolutionScope["descendantOf"],
): NestedRunSummary[] {
  if (!scope) {
    return collectNestedRuns(children);
  }
  return (children ?? []).flatMap((child) => {
    if (
      child.parentRunId === scope.parentRunId &&
      (scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)
    ) {
      return collectNestedRuns([child]);
    }
    return collectScopedNestedRuns(child.children, scope).concat(
      collectScopedNestedRuns(
        child.steps?.flatMap((step) => step.children ?? []),
        scope,
      ),
    );
  });
}
function routeMatches(
  route: NestedRoute,
  id: string,
  options: { readonly prefix?: boolean; readonly scope?: NestedRunResolutionScope },
): NestedRunMatch[] {
  try {
    const registry = projectNestedEvents(route);
    return collectScopedNestedRuns(registry.children, options.scope?.descendantOf)
      .filter((run) => (options.prefix === true ? run.id.startsWith(id) : run.id === id))
      .map((run) => ({ rootRunId: route.rootRunId, route, run }));
  } catch {
    // An invalid route never authorizes an indexed control target.
    return [];
  }
}

export function findNestedRunMatchesById(
  id: string,
  options: { readonly prefix?: boolean; readonly scope?: NestedRunResolutionScope } = {},
): NestedRunMatch[] {
  assertSafeId("id", id);
  return (options.scope?.routes ?? listNestedRoutes()).flatMap((route) =>
    routeMatches(route, id, options),
  );
}

export function readNestedRegistry(route: NestedRoute): NestedRegistry {
  validateRouteShape(route);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryPath(route), "utf-8"));
    if (!isRecord(parsed)) {
      throw new Error("Invalid nested registry.");
    }
    return {
      rootRunId: route.rootRunId,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      children: isUnknownArray(parsed.children)
        ? parsed.children
            .map((child) => sanitizeSummary(child))
            .filter((child): child is NestedRunSummary => Boolean(child))
        : [],
      processedEvents: isUnknownArray(parsed.processedEvents)
        ? parsed.processedEvents.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
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
