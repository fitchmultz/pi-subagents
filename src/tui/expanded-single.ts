import { nonemptyText } from "./text-values.ts";
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
  if (r.detached === true || r.interrupted === true) {
    return theme.fg("warning", r.detached === true ? "detached" : "paused");
  }
  if (r.acceptance?.status === "blocked") {
    return theme.fg("warning", "needs your action");
  }
  return theme.fg("success", "ok");
}

export function renderSingleExpanded(
  d: DetailsInput,
  r: ResultInput,
  theme: Theme,
  options: { readonly isError: boolean; readonly receipt?: string; readonly showRun: boolean },
): Component {
  const c = new Container(),
    running = !options.isError && r.progress?.status === "running";
  const progress = running ? r.progress : r.progressSummary;
  const progressInfo = progress
    ? ` | ${progress.toolCount} tools, ${formatTokens(progress.tokens)} tok, ${formatDuration(progress.durationMs)}`
    : "";
  const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
  c.addChild(
    new Text(
      `${singleStatus(r, theme, options.isError)} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`,
      0,
      0,
    ),
  );
  if (options.showRun && d.runId !== undefined) {
    c.addChild(new Text(theme.fg("dim", `Run: ${d.runId}`), 0, 0));
  }
  c.addChild(new Spacer(1));
  c.addChild(new Text(theme.fg("dim", `Task: ${r.task}`), 0, 0));
  c.addChild(new Spacer(1));
  if (running && r.progress) {
    const live = liveContent(r.progress, theme, "", r.artifactPaths?.outputPath);
    c.addChild(live);
    if (live.children.length > 0) {
      c.addChild(new Spacer(1));
    }
  }
  c.addChild(resultContent(r, theme, nonemptyText(r.truncation?.text) || getSingleResultOutput(r)));
  if (options.receipt !== undefined && options.receipt.length > 0) {
    c.addChild(new Text(options.receipt, 0, 0));
  }
  c.addChild(new Spacer(1));
  c.addChild(profileContent(r, theme));
  c.addChild(accountingContent(r, theme, running));
  return c;
}
