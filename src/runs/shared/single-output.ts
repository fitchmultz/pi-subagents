import * as fs from "node:fs";
import * as path from "node:path";
import type { OutputMode, SavedOutputReference } from "../../shared/types.ts";
import { errorCode, errorText, nonempty } from "./child-json.ts";

export interface SingleOutputSnapshot {
  readonly exists: boolean;
  readonly mtimeMs?: number;
  readonly ctimeMs?: number;
  readonly size?: number;
  readonly ino?: number;
}

export interface SingleOutputCleanupResult {
  readonly path: string;
  readonly action: "deleted" | "already-missing" | "skipped";
  readonly reason?: string;
  readonly error?: string;
}

export function normalizeSingleOutputOverride(
  output: string | boolean | undefined,
  defaultOutput: string | false | undefined,
): string | false | undefined {
  if (output === false || output === "false") {
    return false;
  }
  if (output === true || output === "true") {
    return defaultOutput;
  }
  if (typeof output === "string" && output.length > 0) {
    return output;
  }
  return undefined;
}

export function resolveSingleOutputPath(
  output: string | boolean | undefined,
  runtimeCwd: string,
  requestedCwd?: string,
): string | undefined {
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    output === "false" ||
    output === "true"
  ) {
    return undefined;
  }
  if (path.isAbsolute(output)) {
    return output;
  }
  let baseCwd = runtimeCwd;
  if (nonempty(requestedCwd)) {
    baseCwd = path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(runtimeCwd, requestedCwd);
  }
  return path.resolve(baseCwd, output);
}

function safeOutputSegment(value: string, fallback: string): string {
  const sanitized = value.replace(/[^\w.-]/g, "_").replace(/^\.+$/, "");
  return sanitized.length > 0 ? sanitized : fallback;
}

export function materializeAgentDefaultOutputPath(params: {
  readonly output: string | false | undefined;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly agent: string;
  readonly index?: number | string;
}): string | false | undefined {
  if (
    typeof params.output !== "string" ||
    params.output.length === 0 ||
    params.output === "false" ||
    params.output === "true"
  ) {
    return params.output;
  }
  if (path.isAbsolute(params.output)) {
    return params.output;
  }
  const suffix =
    params.index !== undefined ? `_${safeOutputSegment(String(params.index), "index")}` : "";
  const safeAgent = safeOutputSegment(params.agent, "agent");
  const safeBaseName = safeOutputSegment(path.basename(params.output), "output.md");
  return path.join(
    params.artifactsDir,
    "requested-outputs",
    `${params.runId}_${safeAgent}${suffix}_${safeBaseName}`,
  );
}

export function injectSingleOutputInstruction(
  task: string,
  outputPath: string | undefined,
): string {
  if (!nonempty(outputPath)) {
    return task;
  }
  return `${task}\n\n---\n**Output:** Write your findings to: ${outputPath}`;
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const newlineMatches = text.match(/\r\n|\r|\n/g);
  return (newlineMatches?.length ?? 0) + (/[\r\n]$/.test(text) ? 0 : 1);
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatSavedOutputReference(
  savedPath: string,
  fullOutput: string,
): SavedOutputReference {
  const absolutePath = path.resolve(savedPath);
  const bytes = Buffer.byteLength(fullOutput, "utf-8");
  const lines = countLines(fullOutput);
  return {
    path: absolutePath,
    bytes,
    lines,
    message: `Output saved to: ${absolutePath} (${formatByteSize(bytes)}, ${lines} ${lines === 1 ? "line" : "lines"}). Read this file if needed.`,
  };
}

function consumedOutputStatus(cleanup: SingleOutputCleanupResult): string {
  if (cleanup.action === "deleted") {
    return "removed after capture";
  }
  if (cleanup.action === "already-missing") {
    return "already absent after capture";
  }
  return `not removed${nonempty(cleanup.reason) ? `: ${cleanup.reason}` : ""}`;
}

export function formatConsumedOutputReference(
  outputPath: string,
  fullOutput: string,
  cleanup: SingleOutputCleanupResult,
): SavedOutputReference {
  const absolutePath = path.resolve(outputPath);
  const bytes = Buffer.byteLength(fullOutput, "utf-8");
  const lines = countLines(fullOutput);
  const status = consumedOutputStatus(cleanup);
  return {
    path: absolutePath,
    bytes,
    lines,
    message: `Output file consumed: ${absolutePath} (${formatByteSize(bytes)}, ${lines} ${lines === 1 ? "line" : "lines"}); ${status}.`,
  };
}

export function findDuplicateOutputPath(
  items: readonly { readonly agent: string; readonly outputPath?: string }[],
): string | undefined {
  const seen = new Map<string, { index: number; agent: string }>();
  for (const [index, item] of items.entries()) {
    const outputPath = item.outputPath;
    if (!nonempty(outputPath)) {
      continue;
    }
    const previous = seen.get(outputPath);
    if (previous) {
      return `Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${item.agent}) resolve output to the same path: ${outputPath}. Use distinct output paths.`;
    }
    seen.set(outputPath, { index, agent: item.agent });
  }
  return undefined;
}

export function validateFileOnlyOutputMode(
  outputMode: OutputMode | undefined,
  outputPath: string | undefined,
  context: string,
): string | undefined {
  if (outputMode === "file-only" && !nonempty(outputPath)) {
    return `${context} sets outputMode: "file-only" but does not configure an output file. Set output to a path or use outputMode: "inline".`;
  }
  return undefined;
}

export function captureSingleOutputSnapshot(
  outputPath: string | undefined,
): SingleOutputSnapshot | undefined {
  if (!nonempty(outputPath)) {
    return undefined;
  }
  try {
    const stat = fs.statSync(outputPath);
    return {
      exists: true,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
      ino: stat.ino,
    };
  } catch {
    // The snapshot is advisory; resolveSingleOutput reports concrete read/write failures.
    return { exists: false };
  }
}

function matchesSnapshot(stat: fs.Stats, snapshot: SingleOutputSnapshot | undefined): boolean {
  return (
    snapshot?.exists === true &&
    stat.mtimeMs === snapshot.mtimeMs &&
    stat.ctimeMs === snapshot.ctimeMs &&
    stat.size === snapshot.size &&
    stat.ino === snapshot.ino
  );
}

function persistSingleOutput(
  outputPath: string | undefined,
  fullOutput: string,
): { savedPath?: string; error?: string } {
  if (!nonempty(outputPath)) {
    return {};
  }
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, fullOutput, "utf-8");
    return { savedPath: outputPath };
  } catch (err) {
    return { error: errorText(err) };
  }
}

export function resolveSingleOutput(
  outputPath: string | undefined,
  fallbackOutput: string,
  beforeRun: SingleOutputSnapshot | undefined,
): {
  fullOutput: string;
  savedPath?: string;
  saveError?: string;
  writtenSnapshot?: SingleOutputSnapshot;
} {
  if (!nonempty(outputPath)) {
    return { fullOutput: fallbackOutput };
  }

  try {
    const stat = fs.statSync(outputPath);
    if (!matchesSnapshot(stat, beforeRun)) {
      // ponytail: acceptance and downstream prompts explicitly request this full
      // individual output; it must fit their heap. Inspection uses readOutputPage.
      return { fullOutput: fs.readFileSync(outputPath, "utf-8"), savedPath: outputPath };
    }
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return {
        fullOutput: fallbackOutput,
        saveError: `Failed to read changed output file: ${errorText(error)}`,
      };
    }
  }

  const save = persistSingleOutput(outputPath, fallbackOutput);
  if (nonempty(save.savedPath)) {
    return {
      fullOutput: fallbackOutput,
      savedPath: save.savedPath,
      writtenSnapshot: captureSingleOutputSnapshot(save.savedPath),
    };
  }
  return { fullOutput: fallbackOutput, saveError: save.error };
}

function equalOutputBytes(fd: number, fullOutput: string, size: number): boolean {
  if (size !== Buffer.byteLength(fullOutput)) {
    return false;
  }
  let position = 0;
  for (let start = 0; start < fullOutput.length;) {
    let end = Math.min(start + 16384, fullOutput.length);
    if (end < fullOutput.length && /[\uD800-\uDBFF]/.test(fullOutput.charAt(end - 1))) {
      end--;
    }
    const expected = Buffer.from(fullOutput.slice(start, end));
    const actual = Buffer.allocUnsafe(expected.length);
    if (
      fs.readSync(fd, actual, 0, actual.length, position) !== actual.length ||
      !actual.equals(expected)
    ) {
      return false;
    }
    position += expected.length;
    start = end;
  }
  return true;
}

function unchangedOutputIdentity(fd: number, outputPath: string, stat: fs.Stats): boolean {
  const current = fs.fstatSync(fd);
  const located = fs.statSync(outputPath);
  return (
    current.ino === stat.ino &&
    current.size === stat.size &&
    current.ctimeMs === stat.ctimeMs &&
    located.ino === current.ino &&
    located.dev === current.dev &&
    located.ctimeMs === current.ctimeMs
  );
}

export function cleanupSingleOutputFile(
  outputPath: string | undefined,
  fullOutput: string,
  beforeRun: SingleOutputSnapshot | undefined,
): SingleOutputCleanupResult | undefined {
  if (!nonempty(outputPath)) {
    return undefined;
  }
  const absolutePath = path.resolve(outputPath);
  try {
    const stat = fs.statSync(outputPath);
    const fd = fs.openSync(outputPath, "r");
    let equal: boolean;
    try {
      equal =
        equalOutputBytes(fd, fullOutput, stat.size) &&
        unchangedOutputIdentity(fd, outputPath, stat);
    } finally {
      fs.closeSync(fd);
    }
    if (!equal) {
      return { path: absolutePath, action: "skipped", reason: "file changed after capture" };
    }
    if (matchesSnapshot(stat, beforeRun)) {
      return { path: absolutePath, action: "skipped", reason: "file preexisted and was unchanged" };
    }
    fs.unlinkSync(outputPath);
    return { path: absolutePath, action: "deleted" };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { path: absolutePath, action: "already-missing" };
    }
    return {
      path: absolutePath,
      action: "skipped",
      error: errorText(error),
    };
  }
}

interface FinalizeOutputInput {
  readonly fullOutput: string;
  readonly truncatedOutput?: string;
  readonly outputPath?: string;
  readonly outputMode?: OutputMode;
  readonly exitCode: number;
  readonly savedPath?: string;
  readonly outputReference?: SavedOutputReference;
  readonly saveError?: string;
  readonly cleanup?: SingleOutputCleanupResult;
}
interface FinalizedOutput {
  displayOutput: string;
  savedPath?: string;
  outputReference?: SavedOutputReference;
  saveError?: string;
}
function successfulOutput(
  params: FinalizeOutputInput,
  displayOutput: string,
  savedPath: string,
): FinalizedOutput {
  const outputReference =
    params.outputReference ??
    (params.cleanup && params.outputMode !== "file-only"
      ? formatConsumedOutputReference(savedPath, params.fullOutput, params.cleanup)
      : formatSavedOutputReference(savedPath, params.fullOutput));
  if (params.outputMode === "file-only") {
    return {
      displayOutput: outputReference.message,
      savedPath,
      outputReference,
    };
  }
  const withReference = `${displayOutput}\n\n${outputReference.message}`;
  return {
    displayOutput: withReference,
    savedPath: params.cleanup ? undefined : savedPath,
    outputReference,
  };
}

export function finalizeSingleOutput(params: FinalizeOutputInput): FinalizedOutput {
  let displayOutput = nonempty(params.truncatedOutput) ? params.truncatedOutput : params.fullOutput;
  if (params.exitCode !== 0) {
    return { displayOutput };
  }
  if (nonempty(params.savedPath)) {
    return successfulOutput(params, displayOutput, params.savedPath);
  }
  if (nonempty(params.saveError) && nonempty(params.outputPath)) {
    displayOutput += `\n\nOutput file error: ${params.outputPath}\n${params.saveError}`;
    return { displayOutput, saveError: params.saveError };
  }
  return { displayOutput };
}
