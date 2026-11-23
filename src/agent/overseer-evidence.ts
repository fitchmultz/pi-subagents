import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import {
  judgeCheckpointsSchema,
  judgeUnavailableSchema,
  type Escalation,
  type JudgeCheckpoint,
  type JudgeCheckpoints,
  type JudgeUnavailable,
  type SkepticFinding,
  type ToolErrorTurn,
} from "./contracts.ts";
import { read, runDirectory, write } from "./storage.ts";

const CONSECUTIVE_ERROR_TURN_LIMIT = 3;

interface ErrorTurn {
  readonly evidence: ToolErrorTurn;
  /** Only compared in memory. Never copied into evidence. */
  readonly failedCalls: readonly ToolCall[];
}

function errorTurn(event: TurnEndEvent, earlier: readonly ErrorTurn[]): ErrorTurn {
  const calls = new Map<string, ToolCall>();
  if (event.message.role === "assistant") {
    for (const item of event.message.content) {
      if (item.type === "toolCall" && item.argumentsError === undefined) {
        calls.set(item.id, item);
      }
    }
  }
  const failedCalls: ToolCall[] = [];
  const earlierCalls = earlier.flatMap((turn) => turn.failedCalls);
  const tools = event.toolResults.map(({ toolName, toolCallId, isError }) => {
    const result = { toolName, toolCallId, isError };
    const call = isError ? calls.get(toolCallId) : undefined;
    if (call?.name !== toolName) {
      return result;
    }
    failedCalls.push(call);
    const match = earlierCalls.find(
      (prior) =>
        prior.name === call.name &&
        prior.namespace === call.namespace &&
        isDeepStrictEqual(prior.arguments, call.arguments),
    );
    return match === undefined ? result : { ...result, repeatedFrom: match.id };
  });
  return { evidence: { messageEntryId: event.messageEntryId, tools }, failedCalls };
}

export class ToolErrorWindow {
  private readonly turns: ErrorTurn[] = [];

  clear(): void {
    this.turns.length = 0;
  }

  record(event: TurnEndEvent): ToolErrorTurn[] | undefined {
    if (!event.toolResults.some((result) => result.isError)) {
      this.clear();
      return undefined;
    }
    this.turns.push(errorTurn(event, this.turns));
    if (this.turns.length >= CONSECUTIVE_ERROR_TURN_LIMIT) {
      return this.turns.map((turn) => turn.evidence);
    }
    return undefined;
  }
}

export function checkpointKindLabel(escalation: Pick<Escalation, "kind">): string {
  switch (escalation.kind) {
    case "shape_check":
      return "early shape check";
    case "skeptic":
      return "skeptic flag";
    case "final_diff":
      return "final diff check";
    case "tool_errors":
      return "tool errors";
  }
}

export function formatFindingsLines(findings: readonly SkepticFinding[]): string[] {
  return findings.map(
    (finding) => `  - [${finding.kind}] ${finding.file}: "${finding.excerpt}" — ${finding.why}`,
  );
}

export function checkpointEvidenceLines(escalation: Escalation): string[] {
  const lines = [`Reason: ${escalation.summary}`];
  if (escalation.findings !== undefined && escalation.findings.length > 0) {
    lines.push("Grounded findings:");
    lines.push(...formatFindingsLines(escalation.findings));
  }
  if (escalation.toolErrorTurns !== undefined) {
    lines.push("Tool outcomes reported by Pi (turn entry and call IDs):");
    for (const { messageEntryId, tools } of escalation.toolErrorTurns) {
      const outcomes = tools.map(({ toolName, toolCallId, isError, repeatedFrom }) => {
        const repeat =
          repeatedFrom === undefined ? "" : ` (same tool and arguments as ${repeatedFrom})`;
        return `${toolName} (${toolCallId}): ${isError ? "failed" : "succeeded"}${repeat}`;
      });
      lines.push(`  Turn ${messageEntryId}: ${outcomes.join("; ")}`);
    }
  }
  return lines;
}

const singleLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

const formatFailedCandidates = (failed: JudgeCheckpoint["failed"]): string =>
  failed === undefined || failed.length === 0
    ? ""
    : `failed: ${failed.map((f) => `${f.model}: ${singleLine(f.reason)}`).join("; ")}`;

function formatCheckpointEntry(entry: JudgeCheckpoint): string {
  const failed = formatFailedCandidates(entry.failed);
  if (entry.outcome === "unavailable") {
    const detail = [entry.error === undefined ? "" : singleLine(entry.error), failed]
      .filter(Boolean)
      .join("; ");
    return detail === "" ? "unavailable" : `unavailable (${detail})`;
  }
  const counts = [
    entry.blockingCount > 0 ? `${entry.blockingCount} blocking` : "",
    entry.noteCount > 0 ? `${entry.noteCount} note` : "",
    entry.droppedUngrounded > 0 ? `${entry.droppedUngrounded} ungrounded dropped` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const meta = [counts, failed].filter(Boolean).join("; ");
  return meta === ""
    ? `${entry.outcome} via ${entry.model}`
    : `${entry.outcome} via ${entry.model} (${meta})`;
}

const judgeUnavailableFile = (base: string, runId: string): string =>
  path.join(runDirectory(base, runId), "judge-unavailable.json");
const judgeCheckpointsFile = (base: string, runId: string): string =>
  path.join(runDirectory(base, runId), "judge-checkpoints.json");

export const judgeUnavailable = (base: string, runId: string): JudgeUnavailable | undefined =>
  read(judgeUnavailableFile(base, runId), judgeUnavailableSchema);

export function recordJudgeUnavailable(base: string, runId: string, summary: string): void {
  write(judgeUnavailableFile(base, runId), { at: Date.now(), summary });
}

export function clearJudgeUnavailable(base: string, runId: string): void {
  fs.rmSync(judgeUnavailableFile(base, runId), { force: true });
}

export function readJudgeCheckpoints(base: string, runId: string): JudgeCheckpoint[] {
  return read(judgeCheckpointsFile(base, runId), judgeCheckpointsSchema)?.checkpoints ?? [];
}

export function recordJudgeCheckpoint(
  base: string,
  runId: string,
  checkpoint: JudgeCheckpoint,
): JudgeCheckpoint {
  const next: JudgeCheckpoints = {
    version: 1,
    checkpoints: [...readJudgeCheckpoints(base, runId), checkpoint],
  };
  write(judgeCheckpointsFile(base, runId), next);
  return checkpoint;
}

export function inspectJudgeCheckpoints(
  base: string,
  runId: string,
  formatTime: (at: number) => string,
): { readonly checkpoints?: JudgeCheckpoint[]; readonly lines: string[] } {
  const all = readJudgeCheckpoints(base, runId);
  if (all.length === 0) {
    return { lines: [] };
  }
  const checkpoints = all.slice(-20);
  const label =
    all.length > checkpoints.length
      ? `latest ${checkpoints.length} of ${all.length}`
      : String(checkpoints.length);
  return {
    checkpoints,
    lines: [
      `Overseer checkpoints (${label}):`,
      ...checkpoints.map((entry) => `  ${formatTime(entry.at)}: ${formatCheckpointEntry(entry)}`),
    ],
  };
}
