import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { NativeJournal } from "../../shared/journal-reader.ts";
import { snapshotNativeUsage } from "./native-usage.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { runCooperatively, runSynchronously } from "../../shared/cooperative.ts";
import { errorMessage, isRecord, recordAt } from "../../shared/unknown.ts";
import type { AsyncRunRecord } from "../background/async-resume.ts";
import { createAsyncRunDiscovery } from "../background/async-status.ts";
import {
  parseDetails,
  parseForegroundResumeRun,
  parseOwnedRun,
  parseSubagentExecutionResult,
} from "../background/run-schemas.ts";
import { collectInvocationAgentNames } from "../../shared/settings.ts";
import {
  normalizeSubagentParamsLike,
  type SubagentParamsLike,
} from "../foreground/subagent-params.ts";
import {
  getRunMetadataDir,
  migrateSupervisorQuestionSteps,
  readRunJson,
  saveQuestionOwner,
  saveRunStatus,
} from "./supervisor-questions.ts";
import {
  ASYNC_DIR,
  SLASH_RESULT_TYPE,
  type ReadonlyDetails,
  type ReadonlyInput,
  type OwnedRun,
  type SubagentState,
  type SubagentRunMode,
} from "../../shared/types.ts";
import { OWNED_RUN_ENTRY, rememberOwnedRun, saveForegroundRun } from "./run-persistence.ts";
import {
  resetOwnedRuns,
  setOwnedRun,
  setForegroundRun,
  suspendRunChanges,
} from "./run-state-owner.ts";
import { recoverOutput } from "./legacy-output-recovery.ts";
import { recoveredAsyncRun, repairLegacyAsyncResult } from "./legacy-async-recovery.ts";

type Invocation = ReadonlyInput<SubagentParamsLike>;
type Calls = Readonly<ReadonlyMap<string, Invocation>>;
type Discovery = { readonly steps: () => Generator<void, AsyncRunRecord[]> };
interface LegacyReceipt {
  readonly entry: SessionEntry;
  readonly details: ReadonlyDetails;
  readonly runId: string;
  readonly mode: SubagentRunMode;
}

function receiptDetails(entry: SessionEntry): ReadonlyDetails | undefined {
  try {
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      ["subagent", "delegate", "agent_runs"].includes(entry.message.toolName)
    ) {
      return parseDetails(entry.message.details);
    }
    if (entry.type === "custom_message" && entry.customType === SLASH_RESULT_TYPE) {
      const result = recordAt(entry.details, "result");
      return result ? parseSubagentExecutionResult(result).details : undefined;
    }
  } catch {
    // Invalid legacy payloads do not grant ownership or establish completion.
  }
  return undefined;
}

function sessionFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return sessionFiles(file);
    }
    return entry.name.endsWith(".jsonl") ? [file] : [];
  });
}

function* restoreDeclaredRuns(
  state: SubagentState,
  ctx: ExtensionContext,
  entries: readonly SessionEntry[],
): Generator<void> {
  const owner = ctx.sessionManager.getSessionId();
  for (const entry of entries) {
    yield;
    if (entry.type !== "custom" || entry.customType !== OWNED_RUN_ENTRY) {
      continue;
    }
    const stored = ctx.sessionManager.getEntry(entry.id);
    if (stored?.type !== "custom") {
      continue;
    }
    try {
      const run = parseOwnedRun(stored.data);
      if (run.ownerSessionId === owner && run.runId !== "") {
        setOwnedRun(state, run);
      }
    } catch {
      // Unvalidated copied or damaged metadata is not an ownership handle.
    }
  }
}

function legacyReceipt(entry: SessionEntry): LegacyReceipt | undefined {
  const details = receiptDetails(entry);
  const runId = details?.runId ?? details?.asyncId;
  if (details && details.mode !== "management" && runId !== undefined && runId !== "") {
    return { entry, details, runId, mode: details.mode };
  }
  return undefined;
}

function* recoveredReceipts(
  ctx: ExtensionContext,
  entries: readonly SessionEntry[],
): Generator<void, LegacyReceipt[]> {
  const receipts: LegacyReceipt[] = [];
  for (const entry of entries) {
    yield;
    const tool =
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      ["subagent", "delegate", "agent_runs"].includes(entry.message.toolName);
    const slash = entry.type === "custom_message" && entry.customType === SLASH_RESULT_TYPE;
    if (!tool && !slash) {
      continue;
    }
    const receipt = ctx.sessionManager.getEntry(entry.id);
    if (!receipt) {
      continue;
    }
    const validated = legacyReceipt(receipt);
    if (validated) {
      receipts.push(validated);
    }
  }
  return receipts;
}

function invocationCalls(entry: SessionEntry): Array<readonly [string, Invocation]> {
  if (entry.type !== "message" || entry.message.role !== "assistant") {
    return [];
  }
  return entry.message.content.flatMap((part): Array<readonly [string, Invocation]> => {
    if (
      part.type !== "toolCall" ||
      !["subagent", "delegate"].includes(part.name) ||
      !isRecord(part.arguments)
    ) {
      return [];
    }
    return [[part.id, normalizeSubagentParamsLike(part.arguments)]];
  });
}

function* legacyCalls(
  ctx: ExtensionContext,
  entries: readonly SessionEntry[],
): Generator<void, Map<string, Invocation>> {
  const calls = new Map<string, Invocation>();
  for (const metadata of entries) {
    yield;
    if (metadata.type !== "message" || metadata.message.role !== "assistant") {
      continue;
    }
    const entry = ctx.sessionManager.getEntry(metadata.id);
    for (const [id, invocation] of entry ? invocationCalls(entry) : []) {
      calls.set(id, invocation);
    }
  }
  return calls;
}

function inheritedReceipts(ctx: ExtensionContext): Readonly<ReadonlySet<string>> | undefined {
  const parent = ctx.sessionManager.getHeader()?.parentSession;
  if (parent === undefined || parent === "") {
    return new Set();
  }
  // A missing fork source cannot prove which copied receipts are genuinely new.
  return fs.existsSync(parent) ? new Set(snapshotNativeUsage(parent)) : undefined;
}

function legacyChildren(
  details: ReadonlyDetails,
  request: Invocation | undefined,
): OwnedRun["children"] {
  return details.results.length > 0
    ? details.results.map((result, index) => ({
        agent: result.agent,
        index,
        task: result.task,
        sessionFile: result.sessionFile,
      }))
    : collectInvocationAgentNames(request ?? {}).map((agent, index) => ({ agent, index }));
}

function legacyLineage(
  details: ReadonlyDetails,
  runId: string,
): Pick<OwnedRun, "rootRunId" | "predecessorRunId" | "source"> {
  return {
    rootRunId: details.managementControl?.revivedFromRunId ?? runId,
    predecessorRunId: details.managementControl?.revivedFromRunId,
    source: (details.asyncId ?? "") !== "" ? "async" : "foreground",
  };
}

function invocationCwd(ctx: ExtensionContext, request: Invocation | undefined): string {
  const cwd = request?.cwd;
  return cwd !== undefined && cwd !== "" ? path.resolve(ctx.cwd, cwd) : ctx.cwd;
}

function legacyRun(ctx: ExtensionContext, receipt: LegacyReceipt, calls: Calls): OwnedRun {
  const { entry, details, runId, mode } = receipt;
  const request =
    entry.type === "message" && entry.message.role === "toolResult"
      ? calls.get(entry.message.toolCallId)
      : undefined;
  return {
    runId,
    ownerSessionId: ctx.sessionManager.getSessionId(),
    ...legacyLineage(details, runId),
    mode,
    cwd: invocationCwd(ctx, request),
    task: details.results.at(0)?.task ?? request?.task ?? "Recovered delegated run",
    startedAt: Date.parse(entry.timestamp),
    asyncDir: details.asyncDir,
    legacy: true,
    children: legacyChildren(details, request),
  };
}

function nativeLaunchCwd(run: OwnedRun, details: ReadonlyDetails): OwnedRun {
  const file = details.results.find((result) => (result.sessionFile ?? "") !== "")?.sessionFile;
  if (file === undefined || file === "" || !fs.existsSync(file)) {
    return run;
  }
  const header = new NativeJournal(file).records.at(0)?.value;
  return header?.type === "session" && typeof header.cwd === "string" && header.cwd !== ""
    ? { ...run, cwd: header.cwd }
    : run;
}

function repairQuestionOwner(run: OwnedRun): void {
  let owner: unknown;
  try {
    owner = readRunJson(path.join(getRunMetadataDir(run.runId), "question-owner.json"));
  } catch {
    // A genuine receipt can repair unusable supplemental metadata.
  }
  const sessionId = isRecord(owner) ? owner.sessionId : undefined;
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    saveQuestionOwner(run.runId, run.ownerSessionId);
  }
}

function saveLegacyForeground(run: OwnedRun, details: ReadonlyDetails): void {
  if (run.source !== "foreground") {
    return;
  }
  const results = details.results.map((result) => {
    const finalOutput =
      result.finalOutput ??
      recoverOutput(result.sessionFile, result.artifactPaths?.outputPath, run.startedAt);
    return { ...result, finalOutput };
  });
  saveForegroundRun({ ...run, results });
}

function* restoreLegacyReceipts(
  state: SubagentState,
  ctx: ExtensionContext,
  entries: readonly SessionEntry[],
): Generator<void> {
  const receipts = yield* recoveredReceipts(ctx, entries);
  const needsCalls = receipts.some((receipt) => state.ownedRuns?.has(receipt.runId) !== true);
  const calls = needsCalls ? yield* legacyCalls(ctx, entries) : new Map<string, Invocation>();
  const inherited = inheritedReceipts(ctx);
  for (const receipt of receipts) {
    yield;
    if (
      !inherited ||
      inherited.has(receipt.entry.id) ||
      state.ownedRuns?.has(receipt.runId) === true
    ) {
      continue;
    }
    recoverLegacyReceipt(state, ctx, receipt, calls);
  }
}

function recoverLegacyReceipt(
  state: SubagentState,
  ctx: ExtensionContext,
  receipt: LegacyReceipt,
  calls: Calls,
): void {
  const { details, runId } = receipt;
  const run = legacyRun(ctx, receipt, calls);
  let recovered = run;
  try {
    recovered = nativeLaunchCwd(run, details);
    saveLegacyForeground(recovered, details);
    repairQuestionOwner(recovered);
    rememberOwnedRun(state, recovered);
  } catch (error) {
    // Receipt ownership survives incomplete supplemental child recovery.
    rememberOwnedRun(state, {
      ...recovered,
      recoveryError: `Saved child recovery remains incomplete: ${errorMessage(error)}`,
    });
    console.error(`Could not recover legacy receipt ${runId}: ${errorMessage(error)}`);
  }
}

function repairLegacyAsyncStatus(record: Readonly<AsyncRunRecord>): void {
  const status = record.status;
  if (!record.durable && status && !["running", "queued"].includes(status.state)) {
    saveRunStatus(status.runId, status);
  }
}

function* discoverOwnedAsync(
  state: SubagentState,
  ctx: ExtensionContext,
  scan: Discovery,
): Generator<void, AsyncRunRecord[]> {
  const records = yield* scan.steps();
  const owner = { ownerSessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
  for (const record of records) {
    yield;
    try {
      const old = record.status ? state.ownedRuns?.get(record.status.runId) : undefined;
      const run = recoveredAsyncRun(record, old, owner);
      if (run) {
        // Legacy terminal status is durable before the owner publishes its recovered handle.
        repairLegacyAsyncStatus(record);
        rememberOwnedRun(state, run);
        repairLegacyAsyncResult(record);
      }
    } catch (error) {
      console.error(
        `Could not recover owned async metadata for '${record.location.resolvedId ?? "unknown"}':`,
        error,
      );
    }
  }
  return records;
}

function recoveredForegroundSessions(
  run: OwnedRun,
  ownerFile: string | undefined,
): OwnedRun | undefined {
  if (
    run.children.some((child) => (child.sessionFile ?? "") !== "") ||
    run.legacy !== true ||
    ownerFile === undefined ||
    ownerFile === ""
  ) {
    return undefined;
  }
  const root = path.join(path.dirname(ownerFile), path.basename(ownerFile, ".jsonl"), run.runId);
  const files = sessionFiles(root).sort();
  return files.length > 0
    ? {
        ...run,
        children: files.map((sessionFile, index) => ({
          agent: run.children[index]?.agent ?? "unknown",
          index,
          sessionFile,
        })),
      }
    : undefined;
}

function* restoreForegroundHandles(state: SubagentState, ctx: ExtensionContext): Generator<void> {
  for (const run of state.ownedRuns?.values() ?? []) {
    yield;
    try {
      const stored = readRunJson(
        path.join(getRunMetadataDir(run.runId), "foreground.json"),
        parseForegroundResumeRun,
      );
      if (stored) {
        setForegroundRun(state, stored);
      }
      const recovered = recoveredForegroundSessions(run, ctx.sessionManager.getSessionFile());
      if (recovered) {
        rememberOwnedRun(state, recovered);
      }
    } catch (error) {
      console.error(`Could not recover foreground owner ${run.runId}: ${errorMessage(error)}`);
    }
  }
}

export interface OwnedRunRestoration {
  readonly startedAt: number;
  readonly records: AsyncRunRecord[];
  readonly discover: () => AsyncRunRecord[];
}

export function restoreOwnedRuns(state: SubagentState, ctx: ExtensionContext): OwnedRunRestoration {
  return runSynchronously(restoreOwnedRunSteps(state, ctx));
}

export async function restoreOwnedRunsAsync(
  state: SubagentState,
  ctx: ExtensionContext,
): Promise<OwnedRunRestoration> {
  // Publish readiness only after restoration, before browse/UI work can consume it.
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
  yield* restoreDeclaredRuns(state, ctx, entries);
  yield* restoreLegacyReceipts(state, ctx, entries);
  // The retained discovery owner admits old slash launches without inventing tool receipts.
  const scan = createAsyncRunDiscovery(ASYNC_DIR, {
    sessionId: ctx.sessionManager.getSessionFile() ?? resolveCurrentSessionId(ctx.sessionManager),
    ownerSessionId,
    receiptRunIds: () => state.ownedRuns?.keys() ?? [],
    skipInvalid: true,
  });
  const discover = () => runSynchronously(discoverOwnedAsync(state, ctx, scan));
  const records = yield* discoverOwnedAsync(state, ctx, scan);
  yield* restoreForegroundHandles(state, ctx);
  return { startedAt, records, discover };
}
