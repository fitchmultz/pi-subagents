import * as fs from "node:fs";
import { getSingleResultOutput } from "../../shared/utils.ts";
import {
  buildManagementControl,
  formatAgentProcessExit,
  formatRunAction,
} from "../../shared/status-format.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { acceptanceHumanAction } from "./acceptance-evaluation.ts";
import type {
  OwnedRun,
  OwnedRunView,
  SubagentExecutionResult,
  SubagentState,
} from "../../shared/types.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";
import { ownedRunView } from "./owned-run-view.ts";

export function compact(value: string, max = 180): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function ownedRunControl(view: OwnedRunView) {
  const active = view.children.find(
    (child) => child.state === "live" && child.activity?.status !== "pending",
  );
  const resumable =
    active ??
    view.children.find(
      (child) => child.state !== "live" && child.sessionFile && !child.missingSession,
    );
  return buildManagementControl({
    state: view.state,
    runId: view.runId,
    index: resumable?.index,
    canReview: view.state !== "live",
    canResume: Boolean(resumable),
    canNudge: Boolean(active),
    canInterrupt: view.canInterrupt,
    intercomTarget: active
      ? resolveSubagentIntercomTarget(view.runId, active.agent, active.index)
      : undefined,
  });
}

export function ownedRunStatusResult(
  run: OwnedRun,
  state: OwnedRunReadState,
  runtime?: SubagentExecutionResult,
  options: { full?: boolean; childSafe?: boolean } = {},
): SubagentExecutionResult {
  const view = ownedRunView(run, state);
  const liveControl =
    view.state === "live" && runtime?.details.managementControl?.state === "live"
      ? runtime.details.managementControl
      : undefined;
  const control = liveControl ?? ownedRunControl(view);
  const lines = [
    `Run: ${run.runId}`,
    `State: ${view.state}`,
    `Mode: ${run.mode} (${run.source})`,
    `Task: ${options.full ? run.task : compact(run.task)}`,
    `Launch cwd: ${run.cwd}`,
    `Root: ${run.rootRunId}`,
    ...(run.predecessorRunId
      ? [`Predecessor: ${run.predecessorRunId} (child ${run.predecessorIndex ?? 0})`]
      : []),
    `Parent review (not sent to child): ${run.review?.decision ?? "unreviewed"}${run.review?.message ? ` — ${options.full ? run.review.message : compact(run.review.message)}` : ""}`,
    `Notification: ${run.delivery ? `recorded ${new Date(run.delivery.notifiedAt).toISOString()}; intercom ${run.delivery.intercomDelivered ? "delivered" : "not confirmed"}` : "not recorded"}`,
    ...(view.attention.length ? [`Attention: ${view.attention.join(", ")}`] : []),
    ...(view.resultPath ? [`Result: ${view.resultPath}`] : []),
    ...(view.diagnosis ? [view.diagnosis] : []),
    ...(runtime && !runtime.isError && (run.source === "async" || liveControl)
      ? runtime.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : []),
  ];
  for (const child of view.children) {
    lines.push(
      `Child ${child.index}: ${child.agent} | ${child.state}${child.result?.acceptance ? ` | validation: ${child.result.acceptance.status}` : ""}`,
    );
    const humanAction = acceptanceHumanAction(child.result?.acceptance);
    if (humanAction) {
      lines.push(`  Needs your action — acceptance incomplete:\n${humanAction}`);
    }
    if (child.state !== "live") {
      lines.push(`  ${formatAgentProcessExit(child.result?.agentProcessExit)}`);
    }
    if (child.sessionFile) {
      lines.push(
        `  Session: ${child.sessionFile}${child.missingSession ? " (missing; continuation unavailable)" : ""}`,
      );
    }
    if (child.result?.auditPath) {
      lines.push(`  Child observations / uncommitted output: ${child.result.auditPath}`);
    }
    if (child.result?.fullOutputPath) {
      lines.push(`  Full output: ${child.result.fullOutputPath}`);
    }
    if (child.result?.accounting?.state === "incomplete") {
      lines.push(
        `  Accounting incomplete: ${child.result.accounting.error ?? "Native billing evidence is unavailable; no work was repeated."}`,
      );
    }
    const artifact = child.result?.artifactPaths?.outputPath;
    if (artifact) {
      lines.push(`  Artifact: ${artifact}${fs.existsSync(artifact) ? "" : " (missing)"}`);
    }
    const metadata = child.result?.artifactPaths?.metadataPath;
    if (metadata) {
      lines.push(
        `  Result metadata (acceptance details when configured): ${metadata}${fs.existsSync(metadata) ? "" : " (missing)"}`,
      );
    }
    if (child.launch) {
      const launch = child.launch;
      lines.push(
        `  Effective model: ${launch.model ?? "native default"}; thinking: ${launch.thinking ?? "native default"}`,
        `  Output: ${launch.output || "disabled"} (${launch.outputMode}); configuration: saved launch snapshot`,
      );
      if (options.full) {
        lines.push(`  Saved launch configuration:\n${JSON.stringify(launch, null, 2)}`);
      }
    } else {
      lines.push("  Configuration: legacy-partial; original profile snapshot was not recorded.");
    }
    const output = child.result && getSingleResultOutput(child.result);
    if (output) {
      lines.push(`  Result: ${compact(output, 600)}`);
    }
    if (child.result?.error) {
      lines.push(`  Error: ${child.result.error}`);
    }
  }
  if (control.capabilities.includes("review")) {
    lines.push(
      `Review (parent-only, not sent to child): ${formatRunAction("review", run.runId, { decision: "accepted" }, options.childSafe)} or decision: "needs_changes".`,
    );
  }
  if (view.continuations.length) {
    lines.push(
      "Continuation history:",
      ...view.continuations.map(
        (next) => `  ${next.predecessorRunId}:${next.predecessorIndex ?? 0} -> ${next.runId}`,
      ),
    );
  }
  if (control.capabilities.includes("resume")) {
    lines.push(
      `Continue: ${formatRunAction("resume", run.runId, { ...(view.children.length > 1 ? { index: control.nextActions.find((action) => action.action === "resume")?.index ?? 0 } : {}), message: "..." }, options.childSafe)}`,
    );
  }
  if (!options.full) {
    lines.push(
      `Full task/configuration: ${formatRunAction("status", run.runId, { full: true }, options.childSafe)}`,
    );
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      ...runtime?.details,
      mode: "management",
      results: [],
      run: view,
      managementControl: control,
    },
  };
}
