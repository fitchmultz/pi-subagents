import { hasText, nonemptyText } from "./text-values.ts";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens } from "../shared/formatters.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import type { Theme } from "./display.ts";
import {
  accountingContent,
  liveContent,
  profileContent,
  resultContent,
} from "./expanded-content.ts";
import type { DetailsInput, ResultInput } from "./result-facts.ts";

function singleStatus(r: ResultInput, theme: Theme, isError: boolean): string {
  if (!isError && r.progress?.status === "running") {
    return theme.fg("warning", "running");
  }
  if (isError || r.timedOut === true || r.exitCode !== 0) {
    return theme.fg("error", "failed");
  }
  return completedStatus(r, theme);
}

function completedStatus(r: ResultInput, theme: Theme): string {
  if (r.detached === true) {
    return theme.fg("warning", "detached");
  }
  if (r.interrupted === true) {
    return theme.fg("warning", "paused");
  }
  if (r.acceptance?.status === "blocked") {
    return theme.fg("warning", "needs your action");
  }
  return theme.fg("success", "ok");
}

function singleHeading(
  context: DetailsInput["context"],
  r: ResultInput,
  theme: Theme,
  isError: boolean,
): Text {
  const running = !isError && r.progress?.status === "running";
  const progress = running ? r.progress : r.progressSummary;
  const progressInfo = progress
    ? ` | ${progress.toolCount} tools, ${formatTokens(progress.tokens)} tok, ${formatDuration(progress.durationMs)}`
    : "";
  const contextBadge = context === "fork" ? theme.fg("warning", " [fork]") : "";
  return new Text(
    `${singleStatus(r, theme, isError)} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`,
    0,
    0,
  );
}

function singleLive(r: ResultInput, theme: Theme, running: boolean): Container {
  const c = new Container();
  if (running && r.progress !== undefined) {
    const live = liveContent(r.progress, theme, "", r.artifactPaths?.outputPath);
    c.addChild(live);
    if (live.children.length > 0) {
      c.addChild(new Spacer(1));
    }
  }
  return c;
}

export function renderSingleExpanded(
  d: DetailsInput,
  r: ResultInput,
  theme: Theme,
  options: { readonly isError: boolean; readonly receipt?: string; readonly showRun: boolean },
): Component {
  const c = new Container(),
    running = !options.isError && r.progress?.status === "running";
  c.addChild(singleHeading(d.context, r, theme, options.isError));
  if (options.showRun && d.runId !== undefined) {
    c.addChild(new Text(theme.fg("dim", `Run: ${d.runId}`), 0, 0));
  }
  c.addChild(new Spacer(1));
  c.addChild(new Text(theme.fg("dim", `Task: ${r.task}`), 0, 0));
  c.addChild(new Spacer(1));
  c.addChild(singleLive(r, theme, running));
  c.addChild(resultContent(r, theme, nonemptyText(r.truncation?.text) ?? getSingleResultOutput(r)));
  if (hasText(options.receipt)) {
    c.addChild(new Text(options.receipt, 0, 0));
  }
  c.addChild(new Spacer(1));
  c.addChild(profileContent(r, theme));
  c.addChild(accountingContent(r, theme, running));
  return c;
}
