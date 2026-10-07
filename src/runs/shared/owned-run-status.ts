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
  ManagementControl,
  OwnedRun,
  OwnedRunView,
  SubagentExecutionResult,
  ReadonlyInput,
} from "../../shared/types.ts";
import type { OwnedRunReadState } from "./owned-run-read-state.ts";
import { ownedRunView } from "./owned-run-view.ts";

type StatusOptions = { readonly full?: boolean; readonly childSafe?: boolean };
type ChildView = OwnedRunView["children"][number];

export function compact(value: string, max = 180): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function ownedRunControl(view: OwnedRunView): ManagementControl {
  const active = view.children.find(
    (child) => child.state === "live" && child.activity?.status !== "pending",
  );
  const resumable =
    active ??
    view.children.find(
      (child) =>
        child.state !== "live" && (child.sessionFile ?? "") !== "" && child.missingSession !== true,
    );
  return buildManagementControl({
    state: view.state,
    runId: view.runId,
    index: resumable?.index,
    canReview: view.state !== "live",
    canResume: resumable !== undefined,
    canNudge: active !== undefined,
    canInterrupt: view.canInterrupt,
    intercomTarget: active
      ? resolveSubagentIntercomTarget(view.runId, active.agent, active.index)
      : undefined,
  });
}

function reviewDescription(run: OwnedRun, full: boolean): string {
  const message = run.review?.message;
  const suffix =
    message !== undefined && message !== "" ? ` — ${full ? message : compact(message)}` : "";
  return `Parent review (not sent to child): ${run.review?.decision ?? "unreviewed"}${suffix}`;
}

function notificationDescription(run: OwnedRun): string {
  if (!run.delivery) {
    return "Notification: not recorded";
  }
  return `Notification: recorded ${new Date(run.delivery.notifiedAt).toISOString()}; intercom ${run.delivery.intercomDelivered ? "delivered" : "not confirmed"}`;
}

function optionalLine(prefix: string, value: string | undefined): string[] {
  return value !== undefined && value !== "" ? [`${prefix}${value}`] : [];
}

function runDescription(run: OwnedRun, view: OwnedRunView, full: boolean): string[] {
  return [
    `Run: ${run.runId}`,
    `State: ${view.state}`,
    `Mode: ${run.mode} (${run.source})`,
    `Task: ${full ? run.task : compact(run.task)}`,
    `Launch cwd: ${run.cwd}`,
    `Root: ${run.rootRunId}`,
    ...((run.predecessorRunId ?? "") !== ""
      ? [`Predecessor: ${run.predecessorRunId ?? ""} (child ${run.predecessorIndex ?? 0})`]
      : []),
    reviewDescription(run, full),
    notificationDescription(run),
    ...(view.attention.length > 0 ? [`Attention: ${view.attention.join(", ")}`] : []),
    ...optionalLine("Result: ", view.resultPath),
    ...optionalLine("", view.diagnosis),
  ];
}

function fileDescription(label: string, file?: string): string[] {
  if (file === undefined || file === "") {
    return [];
  }
  return [`  ${label}: ${file}${fs.existsSync(file) ? "" : " (missing)"}`];
}

function childEvidence(child: ChildView): string[] {
  const result = child.result;
  const output = result ? getSingleResultOutput(result) : "";
  const humanAction = acceptanceHumanAction(result?.acceptance);
  return [
    ...optionalLine("  Needs your action — acceptance incomplete:\n", humanAction),
    ...(child.state !== "live" ? [`  ${formatAgentProcessExit(result?.agentProcessExit)}`] : []),
    ...childOutputPaths(child),
    ...(output !== "" ? [`  Result: ${compact(output, 600)}`] : []),
    ...optionalLine("  Error: ", result?.error),
  ];
}

function childOutputPaths(child: ChildView): string[] {
  const result = child.result;
  return [
    ...optionalLine("  Child observations / uncommitted output: ", result?.auditPath),
    ...optionalLine("  Full output: ", result?.fullOutputPath),
    ...fileDescription("Artifact", result?.artifactPaths?.outputPath),
    ...fileDescription(
      "Result metadata (acceptance details when configured)",
      result?.artifactPaths?.metadataPath,
    ),
  ];
}

function childConfiguration(child: ChildView, full: boolean): string[] {
  const launch = child.launch;
  if (!launch) {
    return ["  Configuration: legacy-partial; original profile snapshot was not recorded."];
  }
  return [
    `  Effective model: ${launch.model ?? "native default"}; thinking: ${launch.thinking ?? "native default"}`,
    `  Output: ${launch.output === false || launch.output === "" ? "disabled" : launch.output} (${launch.outputMode}); configuration: saved launch snapshot`,
    ...(full ? [`  Saved launch configuration:\n${JSON.stringify(launch, null, 2)}`] : []),
  ];
}

function childSession(child: ChildView): string[] {
  const file = child.sessionFile;
  if (file === undefined || file === "") {
    return [];
  }
  return [
    `  Session: ${file}${child.missingSession === true ? " (missing; continuation unavailable)" : ""}`,
  ];
}

function childAccounting(child: ChildView): string[] {
  const accounting = child.result?.accounting;
  return accounting?.state === "incomplete"
    ? [
        `  Accounting incomplete: ${accounting.error ?? "Native billing evidence is unavailable; no work was repeated."}`,
      ]
    : [];
}

function childDescription(child: ChildView, full: boolean): string[] {
  const result = child.result;
  return [
    `Child ${child.index}: ${child.agent} | ${child.state}${result?.acceptance ? ` | validation: ${result.acceptance.status}` : ""}`,
    ...childEvidence(child),
    ...childSession(child),
    ...childAccounting(child),
    ...childConfiguration(child, full),
  ];
}

function actionDescription(
  view: OwnedRunView,
  control: ManagementControl,
  options: StatusOptions,
): string[] {
  const resumeIndex = control.nextActions.find((action) => action.action === "resume")?.index ?? 0;
  return [
    ...(control.capabilities.includes("review")
      ? [
          `Review (parent-only, not sent to child): ${formatRunAction("review", view.runId, { decision: "accepted" }, options.childSafe)} or decision: "needs_changes".`,
        ]
      : []),
    ...(view.continuations.length > 0
      ? [
          "Continuation history:",
          ...view.continuations.map(
            (next) => `  ${next.predecessorRunId}:${next.predecessorIndex ?? 0} -> ${next.runId}`,
          ),
        ]
      : []),
    ...(control.capabilities.includes("resume")
      ? [
          `Continue: ${formatRunAction("resume", view.runId, { ...(view.children.length > 1 ? { index: resumeIndex } : {}), message: "..." }, options.childSafe)}`,
        ]
      : []),
    ...(options.full !== true
      ? [
          `Full task/configuration: ${formatRunAction("status", view.runId, { full: true }, options.childSafe)}`,
        ]
      : []),
  ];
}

function runtimeDescription(
  runtime: ReadonlyInput<SubagentExecutionResult> | undefined,
  include: boolean,
): string[] {
  if (!runtime || runtime.isError === true || !include) {
    return [];
  }
  return runtime.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

export function ownedRunStatusResult(
  run: OwnedRun,
  state: OwnedRunReadState,
  runtime?: ReadonlyInput<SubagentExecutionResult>,
  options: StatusOptions = {},
): SubagentExecutionResult {
  const view = ownedRunView(run, state);
  const liveControl =
    view.state === "live" && runtime?.details.managementControl?.state === "live"
      ? runtime.details.managementControl
      : undefined;
  const control = liveControl ?? ownedRunControl(view);
  const runtimeText = runtimeDescription(
    runtime,
    run.source === "async" || liveControl !== undefined,
  );
  const lines = [
    ...runDescription(run, view, options.full === true),
    ...runtimeText,
    ...view.children.flatMap((child) => childDescription(child, options.full === true)),
    ...actionDescription(view, control, options),
  ];
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
