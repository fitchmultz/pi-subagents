import { hasText, nonemptyText } from "./text-values.ts";
import type { ReadonlyInput, AgentProgress, Details } from "../shared/types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatTokens,
  formatDuration,
  formatModelThinking,
  formatToolCall,
} from "../shared/formatters.ts";
import { getDisplayItems } from "../shared/utils.ts";
import { formatActivityLabel } from "../shared/status-format.ts";
import { acceptanceHumanAction } from "../runs/shared/acceptance.ts";

export type Theme = ExtensionContext["ui"]["theme"];

export function getTermWidth(): number {
  return process.stdout.columns > 0 ? process.stdout.columns : 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 *
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 *
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
export function truncLine(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) {
    return text;
  }

  const targetWidth = maxWidth - 1;
  let result = "";
  let currentWidth = 0;
  let activeStyles: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) {
      const code = ansiMatch[0];
      result += code;

      if (code === "\x1b[0m" || code === "\x1b[m") {
        activeStyles = [];
      } else {
        activeStyles.push(code);
      }
      i += code.length;
      continue;
    }

    let end = i;
    while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
      end++;
    }

    const textPortion = text.slice(i, end);
    for (const seg of segmenter.segment(textPortion)) {
      const grapheme = seg.segment;
      const graphemeWidth = visibleWidth(grapheme);

      if (currentWidth + graphemeWidth > targetWidth) {
        return result + activeStyles.join("") + "…";
      }

      result += grapheme;
      currentWidth += graphemeWidth;
    }
    i = end;
  }

  return result + activeStyles.join("") + "…";
}

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATIC_RUNNING_GLYPH = "●";

type ProgressSeedSource = Partial<
  Pick<
    AgentProgress,
    | "index"
    | "toolCount"
    | "tokens"
    | "durationMs"
    | "lastActivityAt"
    | "currentToolStartedAt"
    | "turnCount"
  >
>;

export function runningSeed(...values: ReadonlyArray<number | undefined>): number | undefined {
  let seed: number | undefined;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) {
      continue;
    }
    seed = (seed ?? 0) + Math.trunc(value);
  }
  return seed;
}

export function runningGlyph(seed?: number): string {
  if (seed === undefined) {
    return STATIC_RUNNING_GLYPH;
  }
  return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length] ?? STATIC_RUNNING_GLYPH;
}

export function progressRunningSeed(
  progress: ReadonlyInput<ProgressSeedSource | undefined>,
): number | undefined {
  if (!progress) {
    return undefined;
  }
  return runningSeed(
    progress.index,
    progress.toolCount,
    progress.tokens,
    progress.durationMs,
    progress.lastActivityAt,
    progress.currentToolStartedAt,
    progress.turnCount,
  );
}

export function extractOutputTarget(task: string): string | undefined {
  const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
  if (hasText(writeToMatch?.[1]?.trim())) {
    return writeToMatch[1].trim();
  }
  const findingsMatch = task.match(/Write your findings to:\s*(\S+)/i);
  if (hasText(findingsMatch?.[1]?.trim())) {
    return findingsMatch[1].trim();
  }
  const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
  if (hasText(outputMatch?.[1]?.trim())) {
    return outputMatch[1].trim();
  }
  return undefined;
}

export function hasEmptyTextOutputWithoutOutputTarget(task: string, output: string): boolean {
  if (hasText(output.trim())) {
    return false;
  }
  return !hasText(extractOutputTarget(task));
}

export function getToolCallLines(
  result: ReadonlyInput<Pick<Details["results"][number], "messages" | "toolCalls">>,
  expanded: boolean,
): string[] {
  if (result.messages) {
    return getDisplayItems(result.messages)
      .filter(
        (item): item is { type: "tool"; name: string; args: Record<string, unknown> } =>
          item.type === "tool",
      )
      .map((item) => formatToolCall(item.name, item.args, expanded));
  }
  return (
    result.toolCalls?.map((toolCall) => (expanded ? toolCall.expandedText : toolCall.text)) ?? []
  );
}

export function snapshotNowForProgress(
  progress: ReadonlyInput<
    Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">
  >,
): number | undefined {
  if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined) {
    return progress.currentToolStartedAt + progress.durationMs;
  }
  return progress.lastActivityAt;
}

export function formatCurrentToolLine(
  progress: ReadonlyInput<
    Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolStartedAt">
  >,
  availableWidth: number,
  expanded: boolean,
  snapshotNow?: number,
): string | undefined {
  if (!hasText(progress.currentTool)) {
    return undefined;
  }
  const maxToolArgsLen = Math.max(50, availableWidth - 20);
  const toolArgsPreview = hasText(progress.currentToolArgs)
    ? expanded || progress.currentToolArgs.length <= maxToolArgsLen
      ? progress.currentToolArgs
      : `${progress.currentToolArgs.slice(0, maxToolArgsLen)}...`
    : "";
  const durationSuffix =
    progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
      ? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
      : "";
  return hasText(toolArgsPreview)
    ? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
    : `${progress.currentTool}${durationSuffix}`;
}

export function buildLiveStatusLine(
  progress: ReadonlyInput<Pick<AgentProgress, "activityState" | "lastActivityAt">>,
  snapshotNow?: number,
): string | undefined {
  if (progress.lastActivityAt !== undefined && snapshotNow !== undefined) {
    return formatActivityLabel(progress.lastActivityAt, progress.activityState, snapshotNow);
  }
  if (progress.activityState === "needs_attention") {
    return "needs attention";
  }
  if (progress.lastActivityAt !== undefined) {
    return "active";
  }
  return undefined;
}

export function themeBold(theme: Theme, text: string): string {
  return theme.bold(text);
}

export function statJoin(theme: Theme, parts: ReadonlyInput<string[]>): string {
  return parts
    .filter(Boolean)
    .map((part) => theme.fg("dim", part))
    .join(` ${theme.fg("dim", "·")} `);
}

export function formatTokenStat(tokens: number): string {
  return `${formatTokens(tokens)} token`;
}

export function formatToolUseStat(count: number): string {
  return `${count} tool use${count === 1 ? "" : "s"}`;
}

export function formatProgressStats(
  theme: Theme,
  progress: ReadonlyInput<Pick<AgentProgress, "toolCount" | "tokens" | "durationMs"> | undefined>,
  includeDuration = true,
): string {
  if (!progress) {
    return "";
  }
  const parts: string[] = [];
  if (progress.toolCount > 0) {
    parts.push(formatToolUseStat(progress.toolCount));
  }
  if (progress.tokens > 0) {
    parts.push(formatTokenStat(progress.tokens));
  }
  if (includeDuration && progress.durationMs > 0) {
    parts.push(formatDuration(progress.durationMs));
  }
  return statJoin(theme, parts);
}

export function firstOutputLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => hasText(line.trim()))
      // One-line status previews reject ASCII controls while retaining ordinary whitespace.
      // oxlint-disable-next-line no-control-regex
      ?.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .trim() ?? ""
  );
}

function formatAcceptanceStatus(
  result: ReadonlyInput<Details["results"][number]>,
): string | undefined {
  const acceptance = result.acceptance;
  if (!hasText(acceptance?.status) || acceptance.status === "not-required") {
    return undefined;
  }
  const finalization = acceptance.finalization
    ? ` · finalization: ${acceptance.finalization.status} after ${acceptance.finalization.turns.length}/${acceptance.finalization.maxTurns} turns`
    : "";
  return `acceptance: ${acceptance.status}${finalization}`;
}

export function resultStatusLine(
  result: ReadonlyInput<Details["results"][number]>,
  output: string,
): string {
  if (result.detached === true) {
    return hasText(result.detachedReason) ? `Detached: ${result.detachedReason}` : "Detached";
  }
  if (result.timedOut === true) {
    return `Timed out${hasText(result.error) ? `: ${result.error}` : ""}`;
  }
  if (result.interrupted === true) {
    return "Paused";
  }
  if (result.exitCode !== 0) {
    return `Error: ${result.error ?? (nonemptyText(firstOutputLine(output)) || `exit ${result.exitCode}`)}`;
  }
  if (result.acceptance?.status === "blocked") {
    return `Needs your action · acceptance incomplete · ${acceptanceHumanAction(result.acceptance)?.split("\n")[0]}`;
  }
  const acceptance = formatAcceptanceStatus(result);
  if (hasText(acceptance)) {
    return `Done · ${acceptance}`;
  }
  if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) {
    return "Done (no text output)";
  }
  return "Done";
}

export function resultGlyph(
  result: ReadonlyInput<Details["results"][number]>,
  output: string,
  theme: Theme,
  options: { readonly running?: boolean; readonly seed?: number } = {},
): string {
  const running = options.running ?? result.progress?.status === "running";
  const seed = options.seed ?? progressRunningSeed(result.progress ?? result.progressSummary);
  if (running) {
    return theme.fg("accent", runningGlyph(seed));
  }
  if (result.detached === true) {
    return theme.fg("warning", "■");
  }
  if (result.timedOut === true) {
    return theme.fg("error", "✗");
  }
  if (result.interrupted === true) {
    return theme.fg("warning", "■");
  }
  if (result.exitCode !== 0) {
    return theme.fg("error", "✗");
  }
  if (result.acceptance?.status === "blocked") {
    return theme.fg("warning", "■");
  }
  if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) {
    return theme.fg("warning", "✓");
  }
  return theme.fg("success", "✓");
}

export function compactCurrentActivity(
  progress: ReadonlyInput<
    Pick<
      AgentProgress,
      | "currentTool"
      | "currentToolArgs"
      | "currentToolStartedAt"
      | "activityState"
      | "lastActivityAt"
      | "durationMs"
    >
  >,
): string {
  const snapshotNow = snapshotNowForProgress(progress);
  return (
    formatCurrentToolLine(progress, getTermWidth() - 4, false, snapshotNow) ??
    buildLiveStatusLine(progress, snapshotNow) ??
    "thinking…"
  );
}

export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string): string {
  const label = formatModelThinking(model, thinking);
  return hasText(label) ? theme.fg("dim", ` (${label})`) : "";
}

export function modelStat(theme: Theme, model?: string): string {
  return hasText(model) ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", model)}` : "";
}
