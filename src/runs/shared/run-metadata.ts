import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parseAsyncResult, parseSupervisorRunContract } from "../background/run-schemas.ts";
import { hasErrorCode, isRecord } from "../../shared/unknown.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { NativeJournal, ownerProjection, readJsonProjection } from "../../shared/journal-reader.ts";
import { runSynchronously } from "../../shared/cooperative.ts";
import type {
  AsyncStatus,
  AsyncResultFile,
  ReadonlyInput,
  SupervisorRunContract,
  SavedLaunchConfig,
} from "../../shared/types.ts";

import {
  getRunMetadataDir,
  safeId,
  QUESTIONS_DIR,
  LEGACY_QUESTIONS_DIR,
} from "./run-metadata-paths.ts";
export {
  getRunMetadataDir,
  safeId,
  QUESTIONS_DIR,
  LEGACY_QUESTIONS_DIR,
} from "./run-metadata-paths.ts";
import { compactOwnerResult } from "./owner-output.ts";
export { compactOwnerResult } from "./owner-output.ts";

function conflictingCompletion(
  previous: string | undefined,
  incoming: string | undefined,
): boolean {
  return (
    previous !== undefined &&
    previous !== "" &&
    incoming !== undefined &&
    incoming !== "" &&
    previous !== incoming
  );
}
export function saveAsyncRunResult(
  runId: string,
  result: ReadonlyInput<AsyncResultFile>,
): ReadonlyInput<AsyncResultFile> {
  const file = path.join(getRunMetadataDir(runId), "result.json");
  const previous = readRunJson(file, parseAsyncResult);
  if (conflictingCompletion(previous?.completionId, result.completionId)) {
    throw new Error("Conflicting completion identity");
  }
  const saved: ReadonlyInput<AsyncResultFile> = {
    ...result,
    recordVersion: 3,
    completionId: previous?.completionId ?? result.completionId ?? randomUUID(),
    ...(preserveLegacyOwner(file, previous) ? { legacySource: `${file}.legacy` } : {}),
    results: result.results?.map((child, index) => compactOwnerResult(runId, index, child)),
  };
  writeAtomicJson(file, saved);
  return saved;
}

function preserveLegacyOwner(
  file: string,
  previous: { readonly recordVersion?: number } | undefined,
): boolean {
  if (!previous || previous.recordVersion === 3) {
    return false;
  }
  try {
    fs.copyFileSync(file, `${file}.legacy`, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
  return true;
}

export function saveRunStatus(runId: string, status: ReadonlyInput<AsyncStatus>): void {
  writeAtomicJson(path.join(getRunMetadataDir(runId), "status.json"), status);
}

export function readRunJson(file: string): unknown;
export function readRunJson<T>(
  file: string,
  // Plain callbacks have no mutable properties; T describes the projected result.
  project: (value: unknown) => T,
): T | undefined;
export function readRunJson(file: string, project?: (value: unknown) => unknown): unknown {
  try {
    const value: unknown = readJsonProjection(file, ownerProjection);
    return project === undefined ? value : project(value);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

export function readQuestionOwner(
  runId: string,
  root = QUESTIONS_DIR,
): { readonly sessionId?: string } | undefined {
  const value = readRunJson(path.join(getRunMetadataDir(runId, root), "question-owner.json"));
  return isRecord(value) && typeof value.sessionId === "string"
    ? { sessionId: value.sessionId }
    : undefined;
}

export function saveQuestionOwner(runId: string, sessionId: string, root = QUESTIONS_DIR): void {
  writeAtomicJson(path.join(root, safeId(runId), "question-owner.json"), { sessionId });
}

function preservedAttemptBaseline(
  previous: SupervisorRunContract | undefined,
  incoming: ReadonlyInput<SupervisorRunContract>,
): Pick<SupervisorRunContract, "attemptBaseline"> {
  return previous?.attemptBaseline && incoming.baselineSource !== "native-migration"
    ? { attemptBaseline: previous.attemptBaseline }
    : {};
}
export function saveQuestionContract(
  runId: string,
  index: number,
  contract: ReadonlyInput<SupervisorRunContract>,
  root = QUESTIONS_DIR,
): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("Child index must be a non-negative integer.");
  }
  const file = path.join(root, safeId(runId), "contracts", `${index}.json`);
  const previous = readRunJson(file, parseSupervisorRunContract);
  writeAtomicJson(file, {
    ...previous,
    ...contract,
    recordVersion: 3,
    ...(preserveLegacyOwner(file, previous) ? { legacySource: `${file}.legacy` } : {}),
    ...preservedAttemptBaseline(previous, contract),
    ...(contract.result ? { result: compactOwnerResult(runId, index, contract.result, root) } : {}),
    ...(previous?.launch ? { launch: previous.launch } : {}),
  });
}

function nativeConfigurationAllowed(contract: SupervisorRunContract): boolean {
  return (
    contract.recordVersion !== 3 &&
    !contract.effectiveConfiguration &&
    contract.launch?.model?.startsWith("claude-code/") !== true
  );
}
function recoverNativeConfiguration(
  contract: SupervisorRunContract,
  sessionFile: string | undefined,
  endedAt: number | undefined,
): Pick<SupervisorRunContract, "effectiveConfiguration"> | undefined {
  if (!nativeConfigurationAllowed(contract)) {
    return;
  }
  if (sessionFile === undefined || sessionFile === "" || !fs.existsSync(sessionFile)) {
    return;
  }
  const journal = new NativeJournal(sessionFile, "inspect", true);
  return { effectiveConfiguration: journal.configuration(endedAt, contract.terminalLeafId) };
}

function withNativeConfiguration(
  contract: SupervisorRunContract,
  launch: SavedLaunchConfig,
  effectiveConfiguration: SupervisorRunContract["effectiveConfiguration"],
): SupervisorRunContract {
  const native = effectiveConfiguration ?? {};
  return { ...contract, effectiveConfiguration, launch: { ...launch, ...native } };
}

export function readQuestionContract(
  runId: string,
  index: number,
  root = QUESTIONS_DIR,
  projection: {
    readonly sessionFile?: string;
    readonly endedAt?: number;
    readonly readConfiguration?: false;
  } = {},
): SupervisorRunContract | undefined {
  const contract = readRunJson(
    path.join(root, safeId(runId), "contracts", `${index}.json`),
    parseSupervisorRunContract,
  );
  if (!contract?.launch || projection.readConfiguration === false) {
    return contract;
  }
  const sessionFile = projection.sessionFile ?? contract.sessionFile;
  // Read native selection once, without rewriting the frozen requested launch.
  const recovery = recoverNativeConfiguration(contract, sessionFile, projection.endedAt);
  if (recovery) {
    saveQuestionContract(runId, index, recovery, root);
  }
  const effectiveConfiguration =
    recovery?.effectiveConfiguration ?? contract.effectiveConfiguration;
  return withNativeConfiguration(contract, contract.launch, effectiveConfiguration);
}

export function migrateSupervisorQuestions(ownerSessionId: string, runId?: string): void {
  runSynchronously(migrateSupervisorQuestionSteps(ownerSessionId, runId));
}

export function* migrateSupervisorQuestionSteps(
  ownerSessionId: string,
  runId?: string,
): Generator<void> {
  if (!fs.existsSync(LEGACY_QUESTIONS_DIR)) {
    return;
  }
  const runs =
    runId === undefined
      ? fs
          .readdirSync(LEGACY_QUESTIONS_DIR, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [safeId(runId)];
  for (const id of runs) {
    yield;
    try {
      const source = getRunMetadataDir(id, LEGACY_QUESTIONS_DIR);
      const owner = readQuestionOwner(id, LEGACY_QUESTIONS_DIR);
      if (owner?.sessionId !== ownerSessionId) {
        continue;
      }
      fs.cpSync(source, getRunMetadataDir(id), { recursive: true, force: false });
    } catch (error) {
      if (runId !== undefined) {
        throw error;
      }
      console.error(`Could not recover legacy questions for ${id}:`, error);
    }
  }
}
