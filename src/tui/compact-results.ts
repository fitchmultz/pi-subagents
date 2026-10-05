import { keyText } from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText, type Component } from "@earendil-works/pi-tui";
import { shortenPath } from "../shared/formatters.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import {
  buildMultiProgressLabel,
  renderEntries,
  resultRowLabel,
  type ChainRenderEntry,
  type MultiProgressLabel,
} from "./workflow-labels.ts";
import { widgetStepGlyph, widgetStepStatus } from "./widget-status.ts";
import {
  totalProgress,
  resultProgress,
  workflowFacts,
  type DetailsInput,
  type ResultInput,
} from "./result-facts.ts";
import { hasText, nonemptyText } from "./text-values.ts";
import {
  statJoin,
  formatProgressStats,
  getTermWidth,
  modelThinkingBadge,
  modelStat,
  resultGlyph,
  compactCurrentActivity,
  truncLine,
  buildLiveStatusLine,
  snapshotNowForProgress,
  resultStatusLine,
  firstOutputLine,
  hasEmptyTextOutputWithoutOutputTarget,
  runningGlyph,
  runningSeed,
  progressRunningSeed,
  themeBold,
  extractOutputTarget,
  type Theme,
} from "./display.ts";

function resultOutput(d: DetailsInput, r: ResultInput): string {
  return (
    nonemptyText(r.truncation?.text) ??
    nonemptyText(getSingleResultOutput(r)) ??
    (d.intercomDelivery?.delivered === true ? d.intercomDelivery.summary : "")
  );
}
function expandLabel(d: DetailsInput): string {
  return `${keyText("app.tools.expand")} ${d.intercomDelivery?.delivered === true ? "receipt details" : "full response"}`;
}
function paths(r: ResultInput, theme: Theme): Container {
  const c = new Container();
  if (hasText(r.sessionFile)) {
    c.addChild(new TruncatedText(theme.fg("dim", `  session: ${shortenPath(r.sessionFile)}`)));
  }
  if (r.artifactPaths) {
    c.addChild(
      new TruncatedText(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`)),
    );
  }
  if (hasText(r.truncation?.artifactPath)) {
    c.addChild(
      new TruncatedText(
        theme.fg("dim", `  full output: ${shortenPath(r.truncation.artifactPath)}`),
      ),
    );
  }
  return c;
}
function singleHeadline(
  d: DetailsInput,
  r: ResultInput,
  theme: Theme,
  isError: boolean,
): Component {
  const progress = r.progress ?? r.progressSummary;
  const running = !isError && r.progress?.status === "running";
  const badge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
  const turns = (r.usage?.turns ?? 0) > 0 ? `⟳ ${r.usage?.turns ?? 0}` : "";
  const stats = statJoin(theme, [turns, formatProgressStats(theme, progress)]);
  const glyph = isError
    ? theme.fg("error", "✗")
    : resultGlyph(r, resultOutput(d, r), theme, { running });
  return new TruncatedText(
    `${glyph} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelThinkingBadge(theme, r.model)}${badge}${hasText(stats) ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
  );
}
function compactLive(r: ResultInput, theme: Theme): Container {
  const c = new Container(),
    width = getTermWidth() - 4,
    progress = r.progress;
  if (!progress) {
    return c;
  }
  const activity = compactCurrentActivity(progress),
    live = buildLiveStatusLine(progress, snapshotNowForProgress(progress));
  c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${activity}`), width), 0, 0));
  if (hasText(live) && live !== activity) {
    c.addChild(new Text(truncLine(theme.fg("dim", `     ${live}`), width), 0, 0));
  }
  const expand = keyText("app.tools.expand");
  if (hasText(expand)) {
    c.addChild(
      new Text(truncLine(theme.fg("accent", `  Press ${expand} for live detail`), width), 0, 0),
    );
  }
  if (r.artifactPaths) {
    c.addChild(
      new Text(
        truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width),
        0,
        0,
      ),
    );
  }
  return c;
}
export function renderSingleCompact(
  d: DetailsInput,
  r: ResultInput,
  theme: Theme,
  isError = false,
): Component {
  const c = new Container(),
    output = nonemptyText(r.truncation?.text) ?? getSingleResultOutput(r);
  c.addChild(singleHeadline(d, r, theme, isError));
  if (!isError && r.progress?.status === "running") {
    c.addChild(compactLive(r, theme));
    return c;
  }
  c.addChild(new TruncatedText(theme.fg("dim", `  ⎿  ${resultStatusLine(r, resultOutput(d, r))}`)));
  const preview = firstOutputLine(output);
  if (
    hasText(preview) &&
    r.exitCode === 0 &&
    !hasEmptyTextOutputWithoutOutputTarget(r.task, output)
  ) {
    c.addChild(new TruncatedText(theme.fg("dim", `     ${preview}`)));
  }
  c.addChild(paths(r, theme));
  c.addChild(new TruncatedText(theme.fg("dim", `  ${expandLabel(d)}`)));
  return c;
}
function compactMultiGlyph(d: DetailsInput, theme: Theme, isError: boolean): string {
  const facts = workflowFacts(d, isError);
  if (facts.running) {
    return theme.fg(
      "accent",
      runningGlyph(runningSeed(progressRunningSeed(totalProgress(d)), d.currentStepIndex)),
    );
  }
  if (facts.failed) {
    return theme.fg("error", "✗");
  }
  return theme.fg(
    facts.paused || facts.blocked ? "warning" : "success",
    facts.paused || facts.blocked ? "■" : "✓",
  );
}
function compactMultiHeading(
  d: DetailsInput,
  theme: Theme,
  label: MultiProgressLabel,
  isError: boolean,
): Component {
  const stats = statJoin(theme, [label.headerLabel, formatProgressStats(theme, totalProgress(d))]);
  const badge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
  return new TruncatedText(
    `${compactMultiGlyph(d, theme, isError)} ${theme.fg("toolTitle", theme.bold(d.mode))}${badge}${hasText(stats) ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
  );
}
function placeholder(
  entry: Extract<ChainRenderEntry, { kind: "placeholder" }>,
  theme: Theme,
): Container {
  const c = new Container();
  c.addChild(
    new TruncatedText(
      `  ${widgetStepGlyph(entry.status, theme)} ${entry.stepLabel}: ${themeBold(theme, entry.agentName)} ${theme.fg("dim", "·")} ${widgetStepStatus(entry.status, theme)}`,
    ),
  );
  if (hasText(entry.error)) {
    c.addChild(new TruncatedText(theme.fg("error", `    ⎿  Error: ${entry.error}`)));
  }
  return c;
}
function needsOutcome(r: ResultInput, output: string): boolean {
  return (
    r.exitCode !== 0 ||
    r.interrupted === true ||
    r.detached === true ||
    r.timedOut === true ||
    r.acceptance?.status === "blocked" ||
    hasEmptyTextOutputWithoutOutputTarget(r.task, output)
  );
}
function rowPaths(r: ResultInput, theme: Theme): Container {
  const c = new Container(),
    target = extractOutputTarget(r.task);
  if (hasText(target)) {
    c.addChild(new TruncatedText(theme.fg("dim", `    output: ${target}`)));
  }
  if (r.artifactPaths) {
    c.addChild(
      new TruncatedText(theme.fg("dim", `    output: ${shortenPath(r.artifactPaths.outputPath)}`)),
    );
  }
  return c;
}
function compactRow(
  d: DetailsInput,
  entry: Extract<ChainRenderEntry, { kind: "result" }>,
  theme: Theme,
  label: MultiProgressLabel,
): { component: Component; live: boolean } {
  const c = new Container(),
    r = d.results[entry.resultIndex];
  if (!r) {
    const pending = label.hasParallelInChain
      ? resultRowLabel(d, label, entry.resultIndex, entry.rowNumber)
      : `${label.itemTitle} ${entry.rowNumber}`;
    c.addChild(new TruncatedText(theme.fg("dim", `  ◦ ${pending}: ${entry.agentName} · pending`)));
    return { component: c, live: false };
  }
  const progress = resultProgress(d, entry.resultIndex),
    running = progress?.status === "running",
    pending = progress?.status === "pending";
  const output =
    nonemptyText(getSingleResultOutput(r)) ??
    (d.intercomDelivery?.delivered === true ? d.intercomDelivery.summary : "");
  const number = progress?.index === undefined ? entry.resultIndex + 1 : progress.index + 1;
  const stats = formatProgressStats(theme, progress),
    glyph = pending
      ? theme.fg("dim", "◦")
      : resultGlyph(r, output, theme, { running, seed: progressRunningSeed(progress) });
  const step = resultRowLabel(d, label, entry.resultIndex, number);
  c.addChild(
    new TruncatedText(
      `  ${glyph} ${step}: ${themeBold(theme, entry.agentName)}${modelStat(theme, r.model)}${hasText(stats) ? ` ${theme.fg("dim", "·")} ${stats}` : ""}${pending ? ` ${theme.fg("dim", "· pending")}` : ""}`,
    ),
  );
  if (running && progress) {
    c.addChild(
      new Text(
        truncLine(
          theme.fg("dim", `    ⎿  ${compactCurrentActivity(progress)}`),
          getTermWidth() - 4,
        ),
        0,
        0,
      ),
    );
  } else if (!pending && needsOutcome(r, output)) {
    c.addChild(
      new TruncatedText(
        theme.fg(r.exitCode !== 0 ? "error" : "dim", `    ⎿  ${resultStatusLine(r, output)}`),
      ),
    );
  }
  c.addChild(rowPaths(r, theme));
  return { component: c, live: running };
}
function multiFooter(
  d: DetailsInput,
  theme: Theme,
  input: { readonly hidden: number; readonly live: boolean; readonly running: boolean },
): Container {
  const c = new Container(),
    expand = keyText("app.tools.expand");
  if (input.hidden > 0) {
    c.addChild(
      new Text(
        theme.fg("dim", `  +${input.hidden} more${hasText(expand) ? ` · ${expand} expands` : ""}`),
        0,
        0,
      ),
    );
  }
  if (input.live && hasText(expand)) {
    c.addChild(new Text(theme.fg("accent", `  Press ${expand} for live detail`), 0, 0));
  }
  if (d.artifacts) {
    c.addChild(new TruncatedText(theme.fg("dim", `  artifacts: ${shortenPath(d.artifacts.dir)}`)));
  }
  if (!input.running) {
    c.addChild(new TruncatedText(theme.fg("dim", `  ${expandLabel(d)}`)));
  }
  return c;
}
export function renderMultiCompact(d: DetailsInput, theme: Theme, isError = false): Component {
  const c = new Container(),
    facts = workflowFacts(d, isError),
    label = buildMultiProgressLabel(d, facts.running);
  c.addChild(compactMultiHeading(d, theme, label, isError));
  const entries = renderEntries(d, label, label.itemTitle.toLowerCase());
  const visible =
    facts.running || facts.failed || facts.paused || facts.blocked ? entries : entries.slice(0, 6);
  let live = false;
  for (const entry of visible) {
    if (entry.kind === "placeholder") {
      c.addChild(placeholder(entry, theme));
      continue;
    }
    const row = compactRow(d, entry, theme, label);
    c.addChild(row.component);
    live ||= row.live;
  }
  c.addChild(
    multiFooter(d, theme, {
      hidden: entries.length - visible.length,
      live,
      running: facts.running,
    }),
  );
  return c;
}
