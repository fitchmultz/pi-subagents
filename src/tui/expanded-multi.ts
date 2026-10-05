import { nonemptyText } from "./text-values.ts";
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
} from "./result-facts.ts";
import { liveContent, profileContent, resultContent } from "./expanded-content.ts";
import {
  buildMultiProgressLabel,
  isDoneResult,
  resultRowLabel,
  renderEntries,
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
  return d.chainAgents
    ?.map((agent, i) => {
      const result = d.results[i];
      let status = "pending";
      if (result) {
        const complete = isDoneResult(result);
        status = expandedResultStatus(
          result,
          false,
          d.intercomDelivery?.delivered !== true && complete,
        );
        if (status === "done" && !complete) {
          status = "pending";
        }
      }
      if (status === "pending" && i === (d.currentStepIndex ?? d.results.length) && running) {
        status = "running";
      }
      const color = status === "pending" ? "dim" : statusColor(status);
      return `${theme.fg(color, status)} ${agent}`;
    })
    .join(theme.fg("dim", " → "));
}
function multiIcon(d: DetailsInput, theme: Theme, isError: boolean): string {
  const facts = workflowFacts(d, isError);
  if (facts.running) {
    return theme.fg("warning", "running");
  }
  const failure =
    isError ||
    d.results.some(
      (r) =>
        (r.exitCode !== 0 || r.timedOut === true) &&
        r.interrupted !== true &&
        r.detached !== true &&
        r.progress?.status !== "running",
    );
  if (
    failure ||
    (facts.failed &&
      d.workflowGraph?.nodes.some((n) => n.status === "failed" || n.status === "timed-out") ===
        true)
  ) {
    return theme.fg("error", "failed");
  }
  if (facts.blocked) {
    return theme.fg("warning", "needs your action");
  }
  if (facts.paused) {
    return theme.fg("warning", "paused");
  }
  const empty =
    d.intercomDelivery?.delivered !== true &&
    d.results.some(
      (r) =>
        r.exitCode === 0 &&
        r.progress?.status !== "running" &&
        hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
    );
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
    r = d.results[entry.resultIndex];
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
  const stats = progress
    ? ` | ${progress.toolCount} tools, ${formatDuration(progress.durationMs)}`
    : "";
  const name = running ? theme.bold(theme.fg("warning", r.agent)) : theme.bold(r.agent);
  c.addChild(
    new Text(
      `${theme.fg(statusColor(status), status)} ${resultRowLabel(d, label, entry.resultIndex, number)}: ${name}${modelThinkingBadge(theme, r.model)}${stats}`,
      0,
      0,
    ),
  );
  c.addChild(new Text(theme.fg("dim", `    task: ${r.task}`), 0, 0));
  const target = extractOutputTarget(r.task);
  if (target !== undefined) {
    c.addChild(new Text(theme.fg("dim", `    output: ${target}`), 0, 0));
  }
  c.addChild(profileContent(r, theme, "    "));
  if (running && progress) {
    if ((progress.skills?.length ?? 0) > 0) {
      c.addChild(
        new Text(theme.fg("accent", `    skills: ${progress.skills?.join(", ") ?? ""}`), 0, 0),
      );
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
        nonemptyText(r.truncation?.text) || getSingleResultOutput(r),
        "      ",
      ),
    );
  }
  c.addChild(new Spacer(1));
  return c;
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
  const total = totalProgress(d) ?? { toolCount: 0, tokens: 0, durationMs: 0 };
  const stats =
    total.toolCount !== 0 || total.tokens !== 0
      ? ` | ${total.toolCount} tools, ${formatTokens(total.tokens)} tok, ${formatDuration(total.durationMs)}`
      : "";
  const badge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
  c.addChild(
    new Text(
      `${multiIcon(d, theme, options.isError)} ${theme.fg("toolTitle", theme.bold(d.mode))}${badge} · ${label.headerLabel}${stats}`,
      0,
      0,
    ),
  );
  if (options.showRun && d.runId !== undefined) {
    c.addChild(new Text(theme.fg("dim", `Run: ${d.runId}`), 0, 0));
  }
  const chain = label.hasParallelInChain ? undefined : chainVisualization(d, theme, facts.running);
  if (chain !== undefined && chain.length > 0) {
    c.addChild(new Text(`  ${chain}`, 0, 0));
  }
  if (options.receipt !== undefined && options.receipt.length > 0) {
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
