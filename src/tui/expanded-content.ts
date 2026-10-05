import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatUsage, shortenPath } from "../shared/formatters.ts";
import { formatAgentProcessExit } from "../shared/status-format.ts";
import {
  getToolCallLines,
  buildLiveStatusLine,
  formatCurrentToolLine,
  snapshotNowForProgress,
  type Theme,
} from "./display.ts";
import type { ResultInput } from "./result-facts.ts";

export function liveContent(
  progress: NonNullable<ResultInput["progressSummary"]>,
  theme: Theme,
  indent: string,
  artifact?: string,
): Container {
  const c = new Container(),
    width = (process.stdout.columns ?? 120) - 4;
  const now = snapshotNowForProgress(progress);
  const tool = formatCurrentToolLine(progress, width, true, now),
    live = buildLiveStatusLine(progress, now);
  if (tool !== undefined) {
    c.addChild(new Text(theme.fg("warning", `${indent}> ${tool}`), 0, 0));
  }
  if (live !== undefined) {
    c.addChild(new Text(theme.fg("accent", `${indent}${live}`), 0, 0));
  }
  const expand = keyText("app.tools.expand");
  if (expand.length > 0) {
    c.addChild(new Text(theme.fg("accent", `${indent}Press ${expand} for live detail`), 0, 0));
  }
  if (artifact !== undefined) {
    c.addChild(
      new Text(
        theme.fg(
          "dim",
          `${indent}${indent.length === 0 ? "Artifacts" : "artifacts"}: ${shortenPath(artifact)}`,
        ),
        0,
        0,
      ),
    );
  }
  const toolIndent = indent.length === 0 ? "" : "      ";
  for (const t of progress.recentTools?.slice(-3) ?? []) {
    c.addChild(new Text(theme.fg("dim", `${toolIndent}${t.tool}: ${t.args}`), 0, 0));
  }
  for (const line of (progress.recentOutput ?? []).slice(-5)) {
    c.addChild(new Text(theme.fg("dim", `${indent.length === 0 ? "  " : "      "}${line}`), 0, 0));
  }
  return c;
}

export function resultContent(
  r: ResultInput,
  theme: Theme,
  output: string,
  toolIndent = "",
): Container {
  const c = new Container(),
    toolLines = getToolCallLines(r, true);
  for (const line of toolLines) {
    c.addChild(new Text(theme.fg("muted", `${toolIndent}${line}`), 0, 0));
  }
  if (toolLines.length > 0) {
    c.addChild(new Spacer(1));
  }
  if (r.error !== undefined && r.error.length > 0 && !output.includes(r.error)) {
    c.addChild(new Text(theme.fg("error", r.error), 0, 0));
  }
  if (output.length > 0) {
    c.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
  }
  return c;
}

export function profileContent(r: ResultInput, theme: Theme, indent = ""): Container {
  const c = new Container();
  const label = (word: string) => (indent.length === 0 ? word : word.toLowerCase());
  if ((r.skills?.length ?? 0) > 0) {
    c.addChild(
      new Text(theme.fg("dim", `${indent}${label("Skills")}: ${r.skills?.join(", ") ?? ""}`), 0, 0),
    );
  }
  if (r.skillsWarning !== undefined && r.skillsWarning.length > 0) {
    c.addChild(new Text(theme.fg("warning", `${indent}Warning: ${r.skillsWarning}`), 0, 0));
  }
  if ((r.attemptedModels?.length ?? 0) > 1) {
    const title = indent.length === 0 ? "Fallbacks" : "model attempts";
    c.addChild(
      new Text(theme.fg("dim", `${indent}${title}: ${r.attemptedModels?.join(" → ") ?? ""}`), 0, 0),
    );
  }
  return c;
}

export function accountingContent(r: ResultInput, theme: Theme, running: boolean): Container {
  const c = new Container();
  const accounting = [
    formatUsage(r.usage, r.model),
    r.accounting?.state === "incomplete" ? "accounting incomplete · reported totals only" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  c.addChild(new Text(theme.fg("dim", accounting), 0, 0));
  if (!running) {
    c.addChild(new Text(theme.fg("dim", formatAgentProcessExit(r.agentProcessExit)), 0, 0));
  }
  if (r.sessionFile !== undefined && r.sessionFile.length > 0) {
    c.addChild(new Text(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`), 0, 0));
  }
  if (!running && r.artifactPaths) {
    c.addChild(new Spacer(1));
    c.addChild(
      new Text(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), 0, 0),
    );
  }
  return c;
}
