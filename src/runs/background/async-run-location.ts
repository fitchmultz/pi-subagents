import * as fs from "node:fs";
import * as path from "node:path";
import { formatRunIdAmbiguity } from "../shared/run-id-ambiguity.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { QUESTIONS_DIR, readRunJson } from "../shared/supervisor-questions.ts";
import { readStatus } from "../../shared/utils.ts";
import { isDurableRun } from "./async-result-file.ts";
import type { AsyncRunLocation, AsyncRunRecord } from "./async-run-record.ts";
import { hasText } from "./async-value.ts";

export interface AsyncResumeParams {
  readonly id?: string;
  readonly runId?: string;
  readonly dir?: string;
  readonly index?: number;
}

function assertRunId(value: string | undefined, field: "id" | "runId"): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) {
    throw new Error(`${field} must be an async run id or prefix, not a path.`);
  }
  return value;
}

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function prefixedRunIds(dir: string, prefix: string, suffix = ""): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && (suffix.length === 0 || entry.endsWith(suffix)))
    .map((entry) => (suffix.length > 0 ? entry.slice(0, -suffix.length) : entry))
    .sort();
}

export function asyncRunRoots(asyncDirRoot: string): string[] {
  return [...new Set([path.resolve(asyncDirRoot), path.resolve(QUESTIONS_DIR)])];
}

function exactResultPath(resultsDir: string, runId: string): string | null {
  const resultPath = path.join(resultsDir, `${runId}.json`);
  if (!insideRoot(resultsDir, resultPath)) {
    throw new Error(`Async result file must be inside ${path.resolve(resultsDir)}.`);
  }
  return fs.existsSync(resultPath) ? resultPath : null;
}

function preferredResult(durableResult: string, resultsDir: string, runId: string): string | null {
  return fs.existsSync(durableResult) ? durableResult : exactResultPath(resultsDir, runId);
}

function resolveAsyncRunRecord(
  runId: string,
  asyncDirRoot: string,
  resultsDir: string,
  readLegacyStatus: boolean,
): AsyncRunRecord {
  assertRunId(runId, "id");
  const durableDir = path.join(QUESTIONS_DIR, runId);
  const legacyDir = path.join(asyncDirRoot, runId);
  const durableStatus = readStatus(durableDir);
  const durableResult = path.join(durableDir, "result.json");
  const durable =
    isDurableRun(durableStatus) || isDurableRun(readRunJson(path.join(durableDir, "launch.json")));
  let asyncDir: string | null = null;
  if (durable) {
    asyncDir = durableDir;
  } else if (fs.existsSync(legacyDir)) {
    asyncDir = legacyDir;
  } else if (durableStatus) {
    asyncDir = durableDir;
  }
  let status = asyncDir === durableDir ? durableStatus : null;
  if (asyncDir !== durableDir && asyncDir !== null && readLegacyStatus) {
    status = readStatus(asyncDir);
  }
  return {
    location: {
      asyncDir,
      resultPath: preferredResult(durableResult, resultsDir, runId),
      resolvedId: runId,
    },
    status,
    durable: durable || isDurableRun(status),
  };
}

export function exactAsyncRunLocation(
  runId: string,
  asyncDirRoot: string,
  resultsDir: string,
): AsyncRunLocation {
  return resolveAsyncRunRecord(runId, asyncDirRoot, resultsDir, false).location;
}

/** Resolve canonical precedence and decode each candidate status once for this pass. */
export function readAsyncRunRecord(
  runId: string,
  asyncDirRoot: string,
  resultsDir: string,
): AsyncRunRecord {
  return resolveAsyncRunRecord(runId, asyncDirRoot, resultsDir, true);
}

export function findAsyncRunPrefixMatches(
  prefix: string,
  asyncDirRoot: string,
  resultsDir: string,
): { readonly id: string; readonly location: AsyncRunLocation }[] {
  const requestedId = assertRunId(prefix, "id");
  if (!hasText(requestedId)) {
    return [];
  }
  const asyncRoot = path.resolve(asyncDirRoot);
  const resultRoot = path.resolve(resultsDir);
  const durableIds = prefixedRunIds(QUESTIONS_DIR, requestedId).filter((id) =>
    ["status.json", "result.json", "launch.json"].some((file) =>
      fs.existsSync(path.join(QUESTIONS_DIR, id, file)),
    ),
  );
  const ids = [
    ...new Set([
      ...prefixedRunIds(asyncRoot, requestedId),
      ...durableIds,
      ...prefixedRunIds(resultRoot, requestedId, ".json"),
    ]),
  ].sort();
  return ids.map((id) => ({ id, location: exactAsyncRunLocation(id, asyncRoot, resultRoot) }));
}

function directoryLocation(
  params: ReadonlyInput<AsyncResumeParams>,
  roots: { readonly asyncRoot: string; readonly resultRoot: string; readonly requestedId?: string },
): AsyncRunLocation {
  const asyncDir = path.resolve(params.dir ?? "");
  if (!asyncRunRoots(roots.asyncRoot).some((root) => insideRoot(root, asyncDir))) {
    throw new Error(
      `Async run directory must be inside ${asyncRunRoots(roots.asyncRoot).join(" or ")}.`,
    );
  }
  const resolvedId = roots.requestedId ?? path.basename(asyncDir);
  if (hasText(roots.requestedId) && roots.requestedId !== path.basename(asyncDir)) {
    throw new Error(
      `Async run id '${roots.requestedId}' does not match directory '${path.basename(asyncDir)}'.`,
    );
  }
  const location = exactAsyncRunLocation(resolvedId, roots.asyncRoot, roots.resultRoot);
  const canonical =
    location.asyncDir !== null &&
    isDurableRun(readRunJson(path.join(location.asyncDir, "launch.json")));
  return { ...location, asyncDir: canonical ? location.asyncDir : asyncDir };
}

export function resolveAsyncRunLocation(
  params: ReadonlyInput<AsyncResumeParams>,
  asyncDirRoot: string,
  resultsDir: string,
): AsyncRunLocation {
  const asyncRoot = path.resolve(asyncDirRoot);
  const resultRoot = path.resolve(resultsDir);
  const requestedId = assertRunId(params.id, "id") ?? assertRunId(params.runId, "runId");
  if (hasText(params.dir)) {
    return directoryLocation(params, { asyncRoot, resultRoot, requestedId });
  }
  if (!hasText(requestedId)) {
    return { asyncDir: null, resultPath: null };
  }
  const direct = exactAsyncRunLocation(requestedId, asyncRoot, resultRoot);
  if (direct.asyncDir !== null || direct.resultPath !== null) {
    return direct;
  }
  const matches = findAsyncRunPrefixMatches(requestedId, asyncRoot, resultRoot);
  if (matches.length > 1) {
    throw new Error(
      formatRunIdAmbiguity(
        "async",
        requestedId,
        matches.map((match) => match.id),
      ),
    );
  }
  return matches[0]?.location ?? { asyncDir: null, resultPath: null, resolvedId: requestedId };
}
