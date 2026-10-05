import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { NativeJournal, readOutputPage } from "../../shared/journal-reader.ts";
import { snapshotNativeUsage } from "./native-usage.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { runCooperatively, runSynchronously } from "../../shared/cooperative.ts";
import { getFinalOutput } from "../../shared/utils.ts";
import { readAsyncResultFile } from "../background/async-result-file.ts";
import type { AsyncRunRecord } from "../background/async-resume.ts";
import { createAsyncRunDiscovery } from "../background/async-status.ts";
import { resolveFinalizationOutput } from "./acceptance-finalization.ts";
import { parseAcceptanceReport, validateAcceptanceReportShape } from "./acceptance-reports.ts";
import { collectInvocationAgentNames } from "../../shared/settings.ts";
import type { SubagentParamsLike } from "../foreground/subagent-params.ts";
import {
  getRunMetadataDir,
  migrateSupervisorQuestionSteps,
  readRunJson,
  saveAsyncRunResult,
  saveRunStatus,
  saveQuestionOwner,
} from "./supervisor-questions.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  SLASH_RESULT_TYPE,
  type Details,
  type ForegroundResumeRun,
  type OwnedRun,
  type SingleResult,
  type SubagentExecutionResult,
  type SubagentState,
} from "../../shared/types.ts";
import {
  OWNED_RUN_ENTRY,
  rememberOwnedRun,
  saveForegroundRun,
  workflowChildren,
} from "./run-persistence.ts";
import {
  resetOwnedRuns,
  setOwnedRun,
  setForegroundRun,
  suspendRunChanges,
} from "./run-state-owner.ts";
import { savedWorkflowNodes } from "./owned-run-view.ts";

function receiptDetails(entry: SessionEntry): Details | undefined {
  if (
    entry.type === "message" &&
    entry.message.role === "toolResult" &&
    ["subagent", "delegate", "agent_runs"].includes(entry.message.toolName)
  ) {
    return entry.message.details as Details | undefined;
  }
  if (entry.type === "custom_message" && entry.customType === SLASH_RESULT_TYPE) {
    const details = entry.details as { result?: SubagentExecutionResult } | undefined;
    return details?.result?.details;
  }
  return undefined;
}

function sessionFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sessionFiles(path.join(root, entry.name))
        : entry.name.endsWith(".jsonl")
          ? [path.join(root, entry.name)]
          : [],
    );
}

function recoverOutput(
  sessionFile: string | undefined,
  outputFile: string | undefined,
  endedAt: number,
): string | undefined {
  if (outputFile && fs.existsSync(outputFile)) {
    return readOutputPage(outputFile).text;
  }
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return undefined;
  }
  const journal = new NativeJournal(sessionFile);
  for (const record of journal.branch(undefined, endedAt).reverse()) {
    if (record.value.type !== "message" || record.value.message?.role !== "assistant") {
      continue;
    }
    const output = getFinalOutput([journal.body(record).message]);
    if (output) {
      return output;
    }
  }
}

function recoverLegacyTerminalOutput(
  sessionFile: string | undefined,
  startedAt: number,
  endedAt: number | undefined,
  acceptance: SingleResult["acceptance"],
): string | undefined {
  const review = acceptance?.finalization;
  const reviewedOutput =
    review?.status === "completed" ? review.turns.at(-1)?.rawOutput : undefined;
  if (reviewedOutput?.trim()) {
    return resolveFinalizationOutput(reviewedOutput, "") || undefined;
  }
  // Live and finalization logs are separate, mutable streams, not a final-answer receipt.
  if (
    endedAt === undefined ||
    !Number.isFinite(endedAt) ||
    !sessionFile ||
    !fs.existsSync(sessionFile)
  ) {
    return;
  }
  const journal = new NativeJournal(sessionFile);
  const records = journal
    .branch(undefined, endedAt)
    .filter(({ value }) => value.type === "message" && Date.parse(value.timestamp) >= startedAt);
  const lastAssistant = records.findLastIndex(({ value }) => value.message?.role === "assistant");
  const messages: Message[] = records.map((record, index) =>
    index === lastAssistant ? journal.body(record).message : record.value.message,
  );
  const index = messages.findLastIndex((message) => message.role === "assistant");
  const last = messages[index];
  if (
    last?.role !== "assistant" ||
    last.errorMessage ||
    !["stop", "toolUse"].includes(last.stopReason) ||
    !Array.isArray(last.content)
  ) {
    return;
  }
  const calls = last.content.filter((part) => part.type === "toolCall");
  if (!calls.length) {
    return index === messages.length - 1 && last.stopReason === "stop"
      ? resolveFinalizationOutput(getFinalOutput([last]), "") || undefined
      : undefined;
  }
  if (calls.length !== 1 || calls[0].name !== "structured_output") {
    return;
  }
  const following = messages.slice(index + 1);
  const result = following.at(-1);
  if (
    following.some((message) => message.role !== "toolResult") ||
    result?.role !== "toolResult" ||
    result.toolCallId !== calls[0].id ||
    result.toolName !== "structured_output" ||
    result.isError
  ) {
    return;
  }
  const value = calls[0].arguments.value;
  if (!value || typeof value !== "object" || !("report" in value)) {
    return;
  }
  if (typeof value.report === "string" && parseAcceptanceReport(value.report).report) {
    return resolveFinalizationOutput(value.report, "") || undefined;
  }
  if (
    "answer" in value &&
    typeof value.answer === "string" &&
    value.answer.trim() &&
    !validateAcceptanceReportShape(value.report)
  ) {
    return value.answer;
  }
}

export interface OwnedRunRestoration {
  startedAt: number;
  records: AsyncRunRecord[];
  discover: () => AsyncRunRecord[];
}

export function restoreOwnedRuns(state: SubagentState, ctx: ExtensionContext): OwnedRunRestoration {
  return runSynchronously(restoreOwnedRunSteps(state, ctx));
}

export async function restoreOwnedRunsAsync(
  state: SubagentState,
  ctx: ExtensionContext,
): Promise<OwnedRunRestoration> {
  // Publish readiness once restoration is complete, before starting browse/UI work.
  const releaseNotifications = suspendRunChanges(state);
  try {
    return await runCooperatively(restoreOwnedRunSteps(state, ctx));
  } finally {
    releaseNotifications();
  }
}

function* restoreOwnedRunSteps(
  state: SubagentState,
  ctx: ExtensionContext,
): Generator<void, OwnedRunRestoration> {
  const startedAt = Date.now();
  const ownerSessionId = ctx.sessionManager.getSessionId();
  const entries = ctx.sessionManager.getEntries();
  resetOwnedRuns(state);
  yield* migrateSupervisorQuestionSteps(ownerSessionId);
  for (const entry of entries) {
    yield;
    if (entry.type !== "custom" || entry.customType !== OWNED_RUN_ENTRY) {
      continue;
    }
    const run = (ctx.sessionManager.getEntry(entry.id) as typeof entry | undefined)?.data as
      | OwnedRun
      | undefined;
    if (run?.ownerSessionId === ownerSessionId && run.runId && Array.isArray(run.children)) {
      setOwnedRun(state, run);
    }
  }
  // Forks copy old entries. Their old receipts are evidence, not ownership for the new parent.
  const inheritedIds = new Set<string>();
  const parentFile = ctx.sessionManager.getHeader()?.parentSession;
  if (parentFile && fs.existsSync(parentFile)) {
    for (const id of snapshotNativeUsage(parentFile)) {
      inheritedIds.add(id);
    }
  }
  const recoveredReceipts: SessionEntry[] = [];
  for (const entry of entries) {
    yield;
    if (
      !(
        (entry.type === "message" &&
          entry.message.role === "toolResult" &&
          ["subagent", "delegate", "agent_runs"].includes(entry.message.toolName)) ||
        (entry.type === "custom_message" && entry.customType === SLASH_RESULT_TYPE)
      )
    ) {
      continue;
    }
    const receipt = ctx.sessionManager.getEntry(entry.id);
    if (receipt) {
      recoveredReceipts.push(receipt);
    }
  }
  const calls = new Map<string, SubagentParamsLike>();
  const needsLegacyCalls = recoveredReceipts.some((entry) => {
    const details = receiptDetails(entry);
    return details && !state.ownedRuns!.has(details.runId ?? details.asyncId ?? "");
  });
  for (const metadata of needsLegacyCalls ? entries : []) {
    yield;
    if (metadata.type !== "message" || metadata.message.role !== "assistant") {
      continue;
    }
    const entry = ctx.sessionManager.getEntry(metadata.id);
    if (
      entry?.type !== "message" ||
      entry.message.role !== "assistant" ||
      !Array.isArray(entry.message.content)
    ) {
      continue;
    }
    for (const part of entry.message.content) {
      if (part.type === "toolCall" && ["subagent", "delegate"].includes(part.name)) {
        calls.set(part.id, part.arguments);
      }
    }
  }
  for (const entry of recoveredReceipts) {
    yield;
    if (inheritedIds.has(entry.id) || (parentFile && !fs.existsSync(parentFile))) {
      continue;
    }
    const details = receiptDetails(entry);
    const runId = details?.runId ?? details?.asyncId;
    if (
      !runId ||
      !details ||
      !Array.isArray(details.results) ||
      (details.mode !== "single" && details.mode !== "parallel" && details.mode !== "chain") ||
      state.ownedRuns.has(runId)
    ) {
      continue;
    }
    const cwd = details.results.find((result) => result.sessionFile)?.sessionFile;
    const request =
      entry.type === "message" && entry.message.role === "toolResult"
        ? calls.get(entry.message.toolCallId)
        : undefined;
    const run: OwnedRun = {
      runId,
      ownerSessionId,
      rootRunId: details.managementControl?.revivedFromRunId ?? runId,
      predecessorRunId: details.managementControl?.revivedFromRunId,
      source: details.asyncId ? "async" : "foreground",
      mode: details.mode,
      cwd: request?.cwd ? path.resolve(ctx.cwd, request.cwd) : ctx.cwd,
      task: details.results[0]?.task ?? request?.task ?? "Recovered delegated run",
      startedAt: Date.parse(entry.timestamp),
      asyncDir: details.asyncDir,
      legacy: true,
      children: details.results.length
        ? details.results.map((result, index) => ({
            agent: result.agent,
            index,
            task: result.task,
            sessionFile: result.sessionFile,
          }))
        : collectInvocationAgentNames(request ?? {}).map((agent, index) => ({ agent, index })),
    };
    try {
      if (cwd && fs.existsSync(cwd)) {
        const header = new NativeJournal(cwd).records[0]?.value;
        if (header?.type === "session" && header.cwd) {
          run.cwd = header.cwd;
        }
      }
      if (run.source === "foreground") {
        saveForegroundRun({
          ...run,
          results: details.results.map((result) => ({
            ...result,
            finalOutput:
              result.finalOutput ??
              recoverOutput(
                result.sessionFile,
                result.artifactPaths?.outputPath,
                Date.parse(entry.timestamp),
              ),
          })),
        });
      }
      let owner: { sessionId?: unknown } | undefined;
      try {
        owner = readRunJson(path.join(getRunMetadataDir(runId), "question-owner.json"));
      } catch {
        /* Unusable metadata can be repaired from the genuine receipt. */
      }
      if (typeof owner?.sessionId !== "string" || !owner.sessionId.trim()) {
        saveQuestionOwner(runId, ownerSessionId);
      }
      rememberOwnedRun(state, run);
    } catch (error) {
      // The genuine receipt still establishes ownership. Keep completion
      // unconfirmed when its supplemental output/context cannot be recovered.
      rememberOwnedRun(state, {
        ...run,
        recoveryError: `Saved child recovery remains incomplete: ${String(error)}`,
      });
      console.error(`Could not recover legacy receipt ${runId}: ${String(error)}`);
    }
  }
  // Pre-update background runs may have no parent tool receipt (for example slash launches).
  const scan = createAsyncRunDiscovery(ASYNC_DIR, {
    sessionId: ctx.sessionManager.getSessionFile() ?? resolveCurrentSessionId(ctx.sessionManager),
    ownerSessionId,
    receiptRunIds: () => state.ownedRuns!.keys(),
    skipInvalid: true,
  });
  function* discoverSteps(): Generator<void, AsyncRunRecord[]> {
    const records = yield* scan.steps();
    for (const { location, status, durable } of records) {
      yield;
      try {
        const asyncDir = location.asyncDir;
        if (!asyncDir || !status) {
          continue;
        }
        const terminal = !["running", "queued"].includes(status.state);
        if (!durable && terminal) {
          saveRunStatus(status.runId, status);
        }
        const old = state.ownedRuns!.get(status.runId);
        const nodes = savedWorkflowNodes(status);
        const declared =
          status.mode === "chain" && nodes && !old?.children.some((child) => child.workflowNodeId)
            ? []
            : (old?.children ?? []);
        const children = workflowChildren(declared, nodes ? status.workflowGraph : undefined);
        rememberOwnedRun(state, {
          ...old,
          runId: status.runId,
          ownerSessionId,
          rootRunId: old?.rootRunId ?? status.runId,
          source: "async",
          mode: status.mode,
          cwd: status.cwd ?? old?.cwd ?? ctx.cwd,
          task: old?.task ?? "Recovered background run",
          startedAt: status.startedAt,
          asyncDir,
          pid: status.pid,
          legacy: old?.legacy ?? !durable,
          children: (status.steps ?? []).map((step, index) => ({
            ...children.find((child) => child.index === index),
            agent: step.agent,
            index,
            ...(status.mode === "chain" && nodes?.[index]
              ? { workflowNodeId: nodes[index].id }
              : {}),
            label: step.label ?? children[index]?.label,
            sessionFile:
              step.sessionFile ?? (status.steps?.length === 1 ? status.sessionFile : undefined),
          })),
        });
        const resultPath = path.join(RESULTS_DIR, `${status.runId}.json`);
        if (
          !durable &&
          terminal &&
          !fs.existsSync(path.join(getRunMetadataDir(status.runId), "result.json"))
        ) {
          if (fs.existsSync(resultPath)) {
            saveAsyncRunResult(status.runId, readAsyncResultFile(resultPath));
          } else if (
            status.steps?.length &&
            status.steps.every((step) => !["running", "pending"].includes(step.status))
          ) {
            const endedAt = status.endedAt ?? status.lastUpdate ?? status.startedAt;
            const results = status.steps.map((step) => {
              const sessionFile =
                step.sessionFile ?? (status.steps!.length === 1 ? status.sessionFile : undefined);
              return {
                agent: step.agent,
                sessionFile,
                model: step.model,
                acceptance: step.acceptance,
                exitCode: step.exitCode,
                agentProcessExit: step.agentProcessExit,
                success: step.status === "complete" || step.status === "completed",
                interrupted: step.status === "paused" || undefined,
                timedOut: step.status === "timed-out" || undefined,
                error: step.error,
                output:
                  recoverLegacyTerminalOutput(
                    sessionFile,
                    step.startedAt ?? status.startedAt,
                    step.endedAt ?? status.endedAt,
                    step.acceptance,
                  ) ?? "",
              };
            });
            saveAsyncRunResult(status.runId, {
              id: status.runId,
              sessionId: status.sessionId,
              mode: status.mode,
              state: status.state,
              success: status.state === "complete",
              error: status.error,
              timestamp: endedAt,
              cwd: status.cwd,
              asyncDir,
              sessionFile: status.sessionFile,
              results,
            });
          }
        }
      } catch (error) {
        console.error(
          `Could not recover owned async metadata for '${location.resolvedId}':`,
          error,
        );
      }
    }
    return records;
  }
  const discover = () => runSynchronously(discoverSteps());
  const records = yield* discoverSteps();
  for (const run of state.ownedRuns.values()) {
    yield;
    try {
      const stored = readRunJson<ForegroundResumeRun>(
        path.join(getRunMetadataDir(run.runId), "foreground.json"),
      );
      if (stored) {
        setForegroundRun(state, stored);
      }
      if (run.children.some((child) => child.sessionFile) || !run.legacy) {
        continue;
      }
      const file = ctx.sessionManager.getSessionFile();
      if (!file) {
        continue;
      }
      const root = path.join(path.dirname(file), path.basename(file, ".jsonl"), run.runId);
      const files = sessionFiles(root).sort();
      if (files.length) {
        rememberOwnedRun(state, {
          ...run,
          children: files.map((sessionFile, index) => ({
            agent: run.children[index]?.agent ?? "unknown",
            index,
            sessionFile,
          })),
        });
      }
    } catch (error) {
      console.error(`Could not recover foreground owner ${run.runId}: ${String(error)}`);
    }
  }
  return { startedAt, records, discover };
}
