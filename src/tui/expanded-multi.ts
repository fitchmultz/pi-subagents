import { hasText, nonemptyText } from "./text-values.ts";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, shortenPath } from "../shared/formatters.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import {
  extractOutputTarget,
  hasEmptyTextOutputWithoutOutputTarget,
  modelThinkingBadge,
  type Theme,
} from "./display.ts";
import {
  expandedResultStatus,
  resultProgress,
  totalProgress,
  workflowFacts,
  type DetailsInput,
  type ResultInput,
} from "./result-facts.ts";
import { liveContent, profileContent, resultContent } from "./expanded-content.ts";
import {
  buildMultiProgressLabel,
  isDoneResult,
  resultRowLabel,
  renderEntries,
  workflowGraphHasStatus,
  type ChainRenderEntry,
  type MultiProgressLabel,
} from "./workflow-labels.ts";
import { widgetStepStatus } from "./widget-status.ts";

function statusColor(status: string): "error" | "warning" | "success" {
  if (status === "failed") {
    return "error";
  }
  return status === "done" || status === "ok" ? "success" : "warning";
}
function chainVisualization(d: DetailsInput, theme: Theme, running: boolean): string | undefined {
  if ((d.chainAgents?.length ?? 0) === 0) {
    return;
  }
  const emptyWarning = d.intercomDelivery?.delivered !== true;
  return d.chainAgents
    ?.map((agent, i) => {
      let status = chainResultStatus(d.results.at(i), emptyWarning);
      if (status === "pending" && i === (d.currentStepIndex ?? d.results.length) && running) {
        status = "running";
      }
      const color = status === "pending" ? "dim" : statusColor(status);
      return `${theme.fg(color, status)} ${agent}`;
    })
    .join(theme.fg("dim", " → "));
}
function chainResultStatus(result: ResultInput | undefined, emptyWarning: boolean): string {
  if (result === undefined) {
    return "pending";
  }
  const complete = isDoneResult(result),
    status = expandedResultStatus(result, false, emptyWarning && complete);
  return status === "done" && !complete ? "pending" : status;
}

function hasFailedResult(results: DetailsInput["results"]): boolean {
  return results.some(
    (r) =>
      (r.exitCode !== 0 || r.timedOut === true) &&
      r.interrupted !== true &&
      r.detached !== true &&
      r.progress?.status !== "running",
  );
}
function hasEmptySuccess(results: DetailsInput["results"]): boolean {
  return results.some(
    (r) =>
      r.exitCode === 0 &&
      r.progress?.status !== "running" &&
      hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
  );
}
function multiIcon(d: DetailsInput, theme: Theme, isError: boolean): string {
  const facts = workflowFacts(d, isError);
  if (facts.running) {
    return theme.fg("warning", "running");
  }
  const failure = isError || hasFailedResult(d.results);
  if (failure || (facts.failed && workflowGraphHasStatus(d, ["failed", "timed-out"]))) {
    return theme.fg("error", "failed");
  }
  if (facts.blocked) {
    return theme.fg("warning", "needs your action");
  }
  if (facts.paused) {
    return theme.fg("warning", "paused");
  }
  return successIcon(d.results, d.intercomDelivery?.delivered === true, theme);
}
function successIcon(results: DetailsInput["results"], delivered: boolean, theme: Theme): string {
  const empty = !delivered && hasEmptySuccess(results);
  return theme.fg(empty ? "warning" : "success", empty ? "warning" : "ok");
}
function placeholder(
  entry: Extract<ChainRenderEntry, { kind: "placeholder" }>,
  theme: Theme,
): Container {
  const c = new Container();
  c.addChild(
    new Text(
      `  ${widgetStepStatus(entry.status, theme)} ${entry.stepLabel}: ${theme.bold(entry.agentName)}`,
      0,
      0,
    ),
  );
  c.addChild(
    new Text(
      theme.fg(entry.status === "failed" ? "error" : "dim", `    status: ${entry.status}`),
      0,
      0,
    ),
  );
  if (entry.error !== undefined && entry.error.length > 0) {
    c.addChild(new Text(theme.fg("error", `    error: ${entry.error}`), 0, 0));
  }
  c.addChild(new Spacer(1));
  return c;
}
function resultRow(
  d: DetailsInput,
  entry: Extract<ChainRenderEntry, { kind: "result" }>,
  theme: Theme,
  label: MultiProgressLabel,
): Container {
  const c = new Container(),
    r = d.results.at(entry.resultIndex);
  if (!r) {
    const pending = label.hasParallelInChain
      ? resultRowLabel(d, label, entry.resultIndex, entry.rowNumber)
      : `${label.itemTitle} ${entry.rowNumber}`;
    c.addChild(new Text(theme.fg("dim", `  ${pending}: ${entry.agentName}`), 0, 0));
    c.addChild(new Text(theme.fg("dim", "    status: pending"), 0, 0));
    c.addChild(new Spacer(1));
    return c;
  }
  const progress = resultProgress(d, entry.resultIndex),
    running = progress?.status === "running";
  const number = typeof progress?.index === "number" ? progress.index + 1 : entry.resultIndex + 1;
  const status = expandedResultStatus(r, running, d.intercomDelivery?.delivered !== true);
  c.addChild(
    resultHeading(r, theme, {
      progress,
      status,
      label: resultRowLabel(d, label, entry.resultIndex, number),
    }),
  );
  c.addChild(resultBody(r, theme, progress));
  c.addChild(new Spacer(1));
  return c;
}
function resultHeading(
  r: ResultInput,
  theme: Theme,
  row: {
    readonly progress: ReturnType<typeof resultProgress>;
    readonly status: string;
    readonly label: string;
  },
): Text {
  const progress = row.progress,
    running = progress?.status === "running";
  const stats = progress
    ? ` | ${progress.toolCount} tools, ${formatDuration(progress.durationMs)}`
    : "";
  const name = running ? theme.bold(theme.fg("warning", r.agent)) : theme.bold(r.agent);
  return new Text(
    `${theme.fg(statusColor(row.status), row.status)} ${row.label}: ${name}${modelThinkingBadge(theme, r.model)}${stats}`,
    0,
    0,
  );
}
function resultBody(
  r: ResultInput,
  theme: Theme,
  progress: ReturnType<typeof resultProgress>,
): Container {
  const c = new Container();
  c.addChild(new Text(theme.fg("dim", `    task: ${r.task}`), 0, 0));
  const target = extractOutputTarget(r.task);
  if (target !== undefined) {
    c.addChild(new Text(theme.fg("dim", `    output: ${target}`), 0, 0));
  }
  c.addChild(profileContent(r, theme, "    "));
  if (progress?.status === "running") {
    const skills = progress.skills ?? [];
    if (skills.length > 0) {
      c.addChild(new Text(theme.fg("accent", `    skills: ${skills.join(", ")}`), 0, 0));
    }
    c.addChild(liveContent(progress, theme, "    ", r.artifactPaths?.outputPath));
  } else {
    if (r.artifactPaths) {
      c.addChild(
        new Text(
          theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`),
          0,
          0,
        ),
      );
    }
    c.addChild(
      resultContent(
        r,
        theme,
        nonemptyText(r.truncation?.text) ?? getSingleResultOutput(r),
        "      ",
      ),
    );
  }
  return c;
}
function multiHeading(d: DetailsInput, theme: Theme, headerLabel: string, isError: boolean): Text {
  const total = totalProgress(d) ?? { toolCount: 0, tokens: 0, durationMs: 0 };
  const stats =
    total.toolCount !== 0 || total.tokens !== 0
      ? ` | ${total.toolCount} tools, ${formatTokens(total.tokens)} tok, ${formatDuration(total.durationMs)}`
      : "";
  const badge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
  return new Text(
    `${multiIcon(d, theme, isError)} ${theme.fg("toolTitle", theme.bold(d.mode))}${badge} · ${headerLabel}${stats}`,
    0,
    0,
  );
}
export function renderMultiExpanded(
  d: DetailsInput,
  theme: Theme,
  options: { readonly isError: boolean; readonly showRun: boolean; readonly receipt?: string },
): Component {
  const c = new Container(),
    facts = workflowFacts(d, options.isError);
  const builtLabel = buildMultiProgressLabel(d, facts.running);
  const label = {
    ...builtLabel,
    showActiveGroupOnly: builtLabel.showActiveGroupOnly && facts.running,
  };
  c.addChild(multiHeading(d, theme, label.headerLabel, options.isError));
  if (options.showRun && d.runId !== undefined) {
    c.addChild(new Text(theme.fg("dim", `Run: ${d.runId}`), 0, 0));
  }
  const chain = label.hasParallelInChain ? undefined : chainVisualization(d, theme, facts.running);
  if (hasText(chain)) {
    c.addChild(new Text(`  ${chain}`, 0, 0));
  }
  if (hasText(options.receipt)) {
    c.addChild(new Text(options.receipt, 0, 0));
  }
  c.addChild(new Spacer(1));
  for (const entry of renderEntries(d, label)) {
    c.addChild(
      entry.kind === "placeholder" ? placeholder(entry, theme) : resultRow(d, entry, theme, label),
    );
  }
  if (d.artifacts) {
    c.addChild(new Spacer(1));
    c.addChild(new Text(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`), 0, 0));
  }
  return c;
}
