import { formatRunIdAmbiguity } from "../shared/run-id-ambiguity.ts";
import { buildManagementControl, formatRunAction } from "../../shared/status-format.ts";
import type {
  ReadonlyForegroundResumeRun,
  ReadonlySubagentState,
  SubagentExecutionResult,
} from "../../shared/types.ts";

const LATEST_ALIASES = new Set(["last", "latest"]);
export function resolveRememberedForegroundRun(
  requested: string | undefined,
  state: ReadonlySubagentState,
): ReadonlyForegroundResumeRun | undefined {
  if (requested === undefined) {
    return;
  }
  const normalized = requested.trim();
  if (normalized.length === 0) {
    return;
  }
  const runs = [...(state.foregroundRuns?.values() ?? [])];
  if (LATEST_ALIASES.has(normalized)) {
    return runs.sort((left, right) => right.updatedAt - left.updatedAt).at(0);
  }
  const direct = state.foregroundRuns?.get(normalized);
  const matches = direct ? [direct] : runs.filter((run) => run.runId.startsWith(normalized));
  if (matches.length > 1) {
    throw new Error(
      formatRunIdAmbiguity(
        "foreground",
        normalized,
        matches.map((run) => run.runId),
      ),
    );
  }
  return matches.at(0);
}
function resumeGuidance(run: ReadonlyForegroundResumeRun, childSafe: boolean): string {
  const child = run.children.find(
    (entry) =>
      entry.sessionFile !== undefined &&
      entry.sessionFile.length > 0 &&
      entry.status !== "detached",
  );
  if (!child && run.children.some((entry) => entry.status === "detached")) {
    return `Completion unconfirmed. Check ${formatRunAction("questions", run.runId, {}, childSafe)} before continuing.`;
  }
  if (run.children.length === 1 && child) {
    return `Continue: ${formatRunAction("resume", run.runId, { message: "..." }, childSafe)}`;
  }
  if (!child) {
    return "Revive: unavailable; no child session file was persisted.";
  }
  return `Continue child: ${formatRunAction("resume", run.runId, { index: child.index, message: "..." }, childSafe)}`;
}
function rememberedState(
  run: ReadonlyForegroundResumeRun,
): "completed" | "paused" | "blocked" | "failed" | "unknown" {
  if (run.error !== undefined && run.error.length > 0) {
    return "failed";
  }
  if (run.children.some((child) => child.status === "failed" || child.status === "timed-out")) {
    return "failed";
  }
  if (run.children.some((child) => child.status === "blocked")) {
    return "blocked";
  }
  if (run.children.some((child) => child.status === "paused")) {
    return "paused";
  }
  if (run.children.some((child) => child.status === "detached")) {
    return "unknown";
  }
  return run.pausedReason !== undefined && run.pausedReason.length > 0 ? "paused" : "completed";
}
function compact(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 239)}…` : normalized;
}
function childLine(child: ReadonlyForegroundResumeRun["children"][number]): string {
  const parts = [`  ${child.index + 1}. ${child.agent} ${child.status}`];
  if (child.sessionFile !== undefined && child.sessionFile.length > 0) {
    parts.push(`session: ${child.sessionFile}`);
  }
  if (child.artifactPath !== undefined && child.artifactPath.length > 0) {
    parts.push(`artifact: ${child.artifactPath}`);
  }
  if (child.summary !== undefined && child.summary.length > 0) {
    parts.push(`final: ${compact(child.summary)}`);
  }
  return parts.join(", ");
}
export function rememberedForegroundStatusResult(
  run: ReadonlyForegroundResumeRun,
  childSafe = false,
): SubagentExecutionResult {
  const state = rememberedState(run);
  const resumable = run.children.find(
    (child) =>
      child.sessionFile !== undefined &&
      child.sessionFile.length > 0 &&
      child.status !== "detached",
  );
  const lines = [`Run: ${run.runId}`, "State: remembered foreground", `Outcome: ${state}`];
  if (run.error !== undefined && run.error.length > 0) {
    lines.push(`Error: ${run.error}`);
  } else if (state === "paused" && run.pausedReason !== undefined && run.pausedReason.length > 0) {
    lines.push(run.pausedReason);
  }
  lines.push(
    `Mode: ${run.mode}`,
    `Updated: ${new Date(run.updatedAt).toISOString()}`,
    `Launch cwd: ${run.cwd}`,
    "Children:",
    ...run.children.map(childLine),
    resumeGuidance(run, childSafe),
    `Status: ${formatRunAction("status", run.runId, {}, childSafe)}`,
  );
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      mode: "management",
      results: [],
      managementControl: buildManagementControl({
        state,
        runId: run.runId,
        index: resumable?.index,
        canResume: resumable !== undefined,
      }),
    },
  };
}
