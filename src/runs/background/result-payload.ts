import * as fs from "node:fs";
import * as path from "node:path";
import { getRunMetadataDir } from "../shared/supervisor-questions.ts";
import { journalStamp } from "../../shared/journal-reader.ts";
import { resolveOrchestratorIntercomTarget } from "../../intercom/intercom-bridge.ts";
import type {
  IntercomEventBus,
  NestedRunSummary,
  SubagentResultIntercomChild,
  AsyncResultChild,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import {
  attachNestedChildrenToResultChildren,
  buildSubagentResultIntercomPayload,
  compactNestedResultChildren,
  deliverSubagentResultIntercomEvent,
  resolveSubagentResultStatus,
} from "../../intercom/result-intercom.ts";
import { projectNestedRegistryForRoot, sanitizeSummary } from "../shared/nested-events.ts";
import {
  isDurableRun,
  readAsyncResultFile,
  type ParsedAsyncResultFile,
} from "./async-result-file.ts";
import { hasText } from "./async-value.ts";

export interface ResultEnvelope {
  readonly resultPath: string;
  readonly durableFile: boolean;
  readonly runId: string;
  readonly stamp: string;
  readonly canonicalPath?: string;
  readonly canonicalStamp?: string;
  readonly data: ReadonlyInput<ParsedAsyncResultFile>;
}
export interface PreparedResult {
  readonly nestedChildren?: NestedRunSummary[];
  readonly children: SubagentResultIntercomChild[];
  readonly hasResultChildren: boolean;
}

function canonicalResult(
  notification: ReadonlyInput<ParsedAsyncResultFile>,
  runId: string,
  durableFile: boolean,
): {
  readonly canonicalPath?: string;
  readonly canonicalStamp?: string;
  readonly data: ReadonlyInput<ParsedAsyncResultFile>;
} {
  const canonicalPath =
    isDurableRun(notification) && !durableFile
      ? path.join(getRunMetadataDir(runId), "result.json")
      : undefined;
  if (canonicalPath === undefined) {
    return { data: notification };
  }
  return {
    canonicalPath,
    canonicalStamp: journalStamp(fs.statSync(canonicalPath, { bigint: true })),
    data: readAsyncResultFile(canonicalPath),
  };
}

function resultCompletionId(
  data: Readonly<Pick<ParsedAsyncResultFile, "completionId" | "timestamp">>,
  runId: string,
): string {
  return data.completionId ?? `legacy:${runId}:${data.timestamp ?? "unknown"}`;
}

export function readResultEnvelope(file: string, resultsDir: string): ResultEnvelope {
  const durableFile = path.isAbsolute(file);
  const resultPath = durableFile ? file : path.join(resultsDir, file);
  const stamp = journalStamp(fs.statSync(resultPath, { bigint: true }));
  const notification = readAsyncResultFile(resultPath);
  const runId = notification.runId ?? notification.id ?? path.basename(file, ".json");
  const { canonicalPath, canonicalStamp, data } = canonicalResult(notification, runId, durableFile);
  if ((data.runId ?? data.id ?? runId) !== runId) {
    throw new Error(`Result identity does not match notification '${runId}'.`);
  }
  if (durableFile && resultPath !== path.join(getRunMetadataDir(runId), "result.json")) {
    throw new Error(`Canonical result identity does not match path '${resultPath}'.`);
  }
  return {
    resultPath,
    durableFile,
    runId,
    stamp,
    canonicalPath,
    canonicalStamp,
    data: {
      ...data,
      completionId: resultCompletionId(data, runId),
    },
  };
}

function nestedChildren(
  value: unknown,
  resultPath: string,
  label: string,
): NestedRunSummary[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    console.error(
      `Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`,
    );
    return undefined;
  }
  const children = value
    .map(sanitizeSummary)
    .filter((child): child is NestedRunSummary => child !== undefined);
  if (children.length !== value.length) {
    console.error(
      `Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`,
    );
  }
  return children.length > 0 ? children : undefined;
}

function resultSummary(
  result: ReadonlyInput<AsyncResultChild>,
  fallback: string | undefined,
): string {
  const output = result.output ?? result.finalOutput ?? fallback;
  const hasOutput = typeof output === "string" && output.trim().length > 0;
  if (result.success === false && hasText(result.error)) {
    return `${result.error}${hasOutput ? `\n\nOutput:\n${output}` : ""}`;
  }
  return hasOutput ? output : "(no output)";
}

function childResultStatus(
  result: ReadonlyInput<AsyncResultChild>,
  overall: string | undefined,
): SubagentResultIntercomChild["status"] {
  return resolveSubagentResultStatus({
    success: result.success,
    exitCode: result.exitCode ?? undefined,
    acceptance: result.acceptance,
    interrupted: result.interrupted,
    state: result.interrupted === true || typeof result.success !== "boolean" ? overall : undefined,
  });
}

function normalizeChild(
  result: ReadonlyInput<AsyncResultChild>,
  index: number,
  envelope: ReadonlyInput<ResultEnvelope>,
  count: number,
): SubagentResultIntercomChild {
  const { data, resultPath } = envelope;
  const artifacts = result.artifactPaths ?? {};
  const sessionPath = result.sessionFile ?? (count === 1 ? data.sessionFile : undefined);
  const children = nestedChildren(result.children, resultPath, `results[${index}].children`);
  return {
    agent: result.agent ?? data.agent ?? `step-${index + 1}`,
    status: childResultStatus(result, data.state),
    summary: resultSummary(result, data.summary),
    index,
    artifactPath: artifacts.outputPath,
    metadataPath: artifacts.metadataPath,
    ...(typeof sessionPath === "string" && fs.existsSync(sessionPath) ? { sessionPath } : {}),
    ...(hasText(result.intercomTarget) ? { intercomTarget: result.intercomTarget } : {}),
    ...(children ? { children } : {}),
  };
}

export function prepareResult(envelope: ReadonlyInput<ResultEnvelope>): PreparedResult | undefined {
  const { data, resultPath, runId } = envelope;
  let nested = compactNestedResultChildren(
    nestedChildren(data.nestedChildren, resultPath, "nestedChildren"),
  );
  if ((nested?.length ?? 0) === 0 && data.nestedChildren === undefined) {
    try {
      nested = compactNestedResultChildren(projectNestedRegistryForRoot(runId)?.children);
    } catch (error) {
      console.error(
        `Failed to enrich subagent result file '${resultPath}' with nested registry children; will retry later:`,
        error,
      );
      return undefined;
    }
  }
  const persistedResults = data.results ?? [];
  const hasResultChildren = persistedResults.length > 0;
  const results = hasResultChildren
    ? persistedResults
    : [{ agent: data.agent, output: data.summary, success: data.success }];
  const children = attachNestedChildrenToResultChildren(
    runId,
    results.map((result, index) => normalizeChild(result, index, envelope, results.length)),
    nested,
  );
  return { nestedChildren: nested, children, hasResultChildren };
}

export async function deliverResultIntercom(
  events: ReadonlyInput<IntercomEventBus>,
  envelope: ReadonlyInput<ResultEnvelope>,
  prepared: ReadonlyInput<PreparedResult>,
): Promise<boolean> {
  const { data, runId } = envelope;
  const target = resolveOrchestratorIntercomTarget(events, data.intercomTarget?.trim() ?? "");
  if (target.length === 0) {
    return false;
  }
  const fallbackMode = prepared.children.length > 1 ? "chain" : "single";
  const mode = data.mode ?? fallbackMode;
  const savedPath = path.join(getRunMetadataDir(runId), "result.json");
  const payload = buildSubagentResultIntercomPayload({
    to: target,
    runId,
    completionId: data.completionId,
    mode,
    source: "async",
    ...(fs.existsSync(savedPath) ? { resultPath: savedPath } : {}),
    status: resolveSubagentResultStatus({ state: data.terminalState }),
    error: data.workflowGraph?.nodes.find((node) => hasText(node.error))?.error,
    children: prepared.children,
    asyncId: data.id,
    asyncDir: data.asyncDir,
  });
  return deliverSubagentResultIntercomEvent(events, payload);
}

export function completionEvent(
  envelope: ReadonlyInput<ResultEnvelope>,
  prepared: ReadonlyInput<PreparedResult>,
  key: string,
  intercomDelivered: boolean,
): object {
  const { data, runId } = envelope;
  const { terminalState: _terminalState, ...eventData } = data;
  return {
    ...eventData,
    agent: data.agent ?? prepared.children.map((child) => child.agent).join(", "),
    summary: hasText(data.summary?.trim())
      ? data.summary
      : prepared.children.map((child) => child.summary).join("\n\n"),
    runId,
    completionKey: key,
    intercomResultDelivered: intercomDelivered,
    ...((prepared.nestedChildren?.length ?? 0) > 0
      ? { nestedChildren: prepared.nestedChildren }
      : {}),
    ...(data.results === undefined
      ? {}
      : {
          results: prepared.hasResultChildren
            ? prepared.children.map((child, index) => ({
                ...data.results?.[index],
                agent: child.agent,
                status: child.status,
                summary: child.summary,
                index: child.index,
                artifactPath: child.artifactPath,
                sessionPath: child.sessionPath,
                children: child.children,
              }))
            : [],
        }),
  };
}
