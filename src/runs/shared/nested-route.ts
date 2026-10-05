import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR, type NestedRunSummary } from "../../shared/types.ts";
import { ensureTempRoot } from "../../shared/temp-root.ts";
import { parseNestedPathEnv, type NestedPathEntry } from "./nested-path.ts";
import {
  SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
  SUBAGENT_PARENT_CONTROL_INBOX_ENV,
  SUBAGENT_PARENT_DEPTH_ENV,
  SUBAGENT_PARENT_EVENT_SINK_ENV,
  SUBAGENT_PARENT_PATH_ENV,
  SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
  SUBAGENT_PARENT_RUN_ID_ENV,
} from "./pi-args.ts";
import { getRunMetadataDir, readRunJson } from "./supervisor-questions.ts";
import {
  assertSafeNestedId as assertSafeId,
  isSafeNestedId,
  type NestedRoute,
  type NestedEventRecord,
  type NestedControlRequestRecord,
  type NestedControlResultRecord,
  NESTED_EVENTS_DIR,
  ROUTE_FILE,
  MAX_EVENT_BYTES,
  MAX_DEPTH,
} from "./nested-protocol.ts";
import { isRecord, hasErrorCode } from "../../shared/unknown.ts";
import { clampNumber } from "./nested-validation.ts";

function containedPath(base: string, candidate: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`)
  );
}

export function commonRouteRoot(route: Pick<NestedRoute, "eventSink" | "controlInbox">): string {
  return path.dirname(path.resolve(route.eventSink));
}

export function validateRouteShape(route: NestedRoute): void {
  assertSafeId("rootRunId", route.rootRunId);
  assertSafeId("capabilityToken", route.capabilityToken);
  if (!containedPath(NESTED_EVENTS_DIR, route.eventSink)) {
    throw new Error("Nested event sink is outside the subagent nested event root.");
  }
  if (!containedPath(NESTED_EVENTS_DIR, route.controlInbox)) {
    throw new Error("Nested control inbox is outside the subagent nested event root.");
  }
  if (commonRouteRoot(route) !== path.dirname(path.resolve(route.controlInbox))) {
    throw new Error("Nested event sink and control inbox must share one route root.");
  }
}

export function createNestedRoute(rootRunId: string): NestedRoute {
  assertSafeId("rootRunId", rootRunId);
  ensureTempRoot();
  const capabilityToken = randomUUID();
  const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-${capabilityToken}`);
  const eventSink = path.join(routeRoot, "events");
  const controlInbox = path.join(routeRoot, "controls");
  fs.mkdirSync(eventSink, { recursive: true, mode: 0o700 });
  fs.mkdirSync(controlInbox, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(routeRoot, ROUTE_FILE),
    `${JSON.stringify({ rootRunId, capabilityToken, createdAt: Date.now() })}\n`,
    { mode: 0o600 },
  );
  return { rootRunId, eventSink, controlInbox, capabilityToken };
}

function routeAddressFromEnv(env: Readonly<NodeJS.ProcessEnv>): NestedRoute | undefined {
  const rootRunId = env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
  const eventSink = env[SUBAGENT_PARENT_EVENT_SINK_ENV];
  const controlInbox = env[SUBAGENT_PARENT_CONTROL_INBOX_ENV];
  const capabilityToken = env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV];
  if (
    rootRunId === undefined ||
    rootRunId === "" ||
    eventSink === undefined ||
    eventSink === "" ||
    controlInbox === undefined ||
    controlInbox === "" ||
    capabilityToken === undefined ||
    capabilityToken === ""
  ) {
    return undefined;
  }
  return { rootRunId, eventSink, controlInbox, capabilityToken };
}

export function resolveNestedRouteFromEnv(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): NestedRoute | undefined {
  const route = routeAddressFromEnv(env);
  if (!route) {
    return;
  }
  validateRouteShape(route);
  const routeFile = path.join(commonRouteRoot(route), ROUTE_FILE);
  const metadata = readRouteMetadata(routeFile);
  if (
    metadata.rootRunId !== route.rootRunId ||
    metadata.capabilityToken !== route.capabilityToken
  ) {
    throw new Error(
      "Nested event route metadata does not match the provided root id and capability token.",
    );
  }
  return route;
}

export function resolveInheritedNestedRouteFromEnv(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): NestedRoute | undefined {
  try {
    return resolveNestedRouteFromEnv(env);
  } catch (error) {
    console.error("Ignoring invalid nested subagent event route:", error);
    return undefined;
  }
}

export function resolveNestedParentAddressFromEnv(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
):
  | { parentRunId: string; parentStepIndex?: number; depth: number; path: NestedPathEntry[] }
  | undefined {
  const parentRunId = env[SUBAGENT_PARENT_RUN_ID_ENV];
  if (!isSafeNestedId(parentRunId)) {
    return undefined;
  }
  const rawIndex = env[SUBAGENT_PARENT_CHILD_INDEX_ENV];
  const parentStepIndex =
    rawIndex !== undefined && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
  const depth = Math.min(
    Math.max(1, clampNumber(Number(env[SUBAGENT_PARENT_DEPTH_ENV])) ?? 1),
    MAX_DEPTH,
  );
  const parsedPath = parseNestedPathEnv(env[SUBAGENT_PARENT_PATH_ENV]);
  const nestedPath =
    parsedPath.length > 0
      ? parsedPath
      : [
          {
            runId: parentRunId,
            ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}),
          },
        ];
  return {
    parentRunId,
    ...(parentStepIndex !== undefined ? { parentStepIndex } : {}),
    depth,
    path: nestedPath,
  };
}

export function resolveNestedAsyncDir(
  rootRunId: string,
  run: NestedRunSummary,
): string | undefined {
  if (run.asyncDir === undefined || run.asyncDir === "") {
    return undefined;
  }
  const resolved = path.resolve(run.asyncDir);
  if (resolved === getRunMetadataDir(run.id)) {
    const launch = readRunJson(path.join(resolved, "launch.json"));
    return durableNestedLaunch(launch, rootRunId, run.parentRunId) ? resolved : undefined;
  }
  const nestedRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, run.id);
  const relative = path.relative(nestedRoot, resolved);
  return resolved === nestedRoot || (!relative.startsWith("..") && !path.isAbsolute(relative))
    ? resolved
    : undefined;
}

function durableNestedLaunch(value: unknown, rootRunId: string, parentRunId: string): boolean {
  return (
    isRecord(value) &&
    value.runtimeVersion === 2 &&
    isRecord(value.nestedRoute) &&
    value.nestedRoute.rootRunId === rootRunId &&
    isRecord(value.nestedSelf) &&
    value.nestedSelf.parentRunId === parentRunId
  );
}

function readRouteMetadata(file: string): {
  readonly rootRunId: string;
  readonly capabilityToken: string;
} {
  const metadata: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (
    !isRecord(metadata) ||
    typeof metadata.rootRunId !== "string" ||
    typeof metadata.capabilityToken !== "string"
  ) {
    throw new Error("Invalid nested route metadata.");
  }
  return { rootRunId: metadata.rootRunId, capabilityToken: metadata.capabilityToken };
}

function readNestedRoute(routeRoot: string): NestedRoute {
  const metadata = readRouteMetadata(path.join(routeRoot, ROUTE_FILE));
  const route = {
    rootRunId: metadata.rootRunId,
    eventSink: path.join(routeRoot, "events"),
    controlInbox: path.join(routeRoot, "controls"),
    capabilityToken: metadata.capabilityToken,
  };
  validateRouteShape(route);
  return route;
}

export function listNestedRoutes(rootRunId?: string): NestedRoute[] {
  const prefix = rootRunId ?? "";
  let entries: string[];
  try {
    entries = fs.readdirSync(NESTED_EVENTS_DIR);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const routes: NestedRoute[] = [];
  for (const entry of entries) {
    if (prefix !== "" && !entry.startsWith(`${prefix}-`)) {
      continue;
    }
    try {
      const route = readNestedRoute(path.join(NESTED_EVENTS_DIR, entry));
      if (prefix === "" || route.rootRunId === prefix) {
        routes.push(route);
      }
    } catch {
      continue;
    }
  }
  return routes;
}

export function readRouteFiles(
  dir: string,
  include: (entry: string) => boolean,
): Array<{ entry: string; filePath: string; content: string }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(include).sort();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return entries.flatMap((entry) => {
    const filePath = path.join(dir, entry);
    if (!containedPath(dir, filePath)) {
      return [];
    }
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile() && stat.size <= MAX_EVENT_BYTES
        ? [{ entry, filePath, content: fs.readFileSync(filePath, "utf-8") }]
        : [];
    } catch {
      return [];
    }
  });
}

export function writeRouteRecord(
  dir: string,
  ts: number,
  payload: NestedEventRecord | NestedControlRequestRecord | NestedControlResultRecord,
): string {
  const content = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) {
    throw new Error("Nested route record exceeds the maximum size.");
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${String(ts).padStart(13, "0")}-${randomUUID()}.json`;
  const tmp = path.join(dir, `.${name}.tmp`);
  const finalPath = path.join(dir, name);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, finalPath);
  return finalPath;
}
