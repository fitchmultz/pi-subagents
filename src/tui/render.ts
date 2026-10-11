import { keyText } from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText, type Component } from "@earendil-works/pi-tui";
import type { ReadonlyInput, SubagentExecutionResult } from "../shared/types.ts";
import { firstOutputLine, getTermWidth, truncLine, type Theme } from "./display.ts";
import { renderSingleCompact, renderMultiCompact } from "./compact-results.ts";
import { renderSingleExpanded } from "./expanded-single.ts";
import { renderMultiExpanded } from "./expanded-multi.ts";
import { workflowFacts, type DetailsInput } from "./result-facts.ts";
import { hasText } from "./text-values.ts";
export { widgetRenderKey } from "./widget-status.ts";
export { buildWidgetLines, renderWidget } from "./widget.ts";
// Native rendering can receive text-only failures before application details exist.
type Result = ReadonlyInput<Pick<SubagentExecutionResult, "content" | "isError">> & {
  readonly details?: DetailsInput;
};
function asyncReceipt(
  d: DetailsInput | undefined,
  text: string,
  prefix: string,
  theme: Theme,
): Component | undefined {
  if (!d || !hasText(d.asyncId) || d.mode === "management") {
    return;
  }
  const headline = hasText(d.managementControl?.revivedFromRunId)
    ? "Revived async"
    : firstOutputLine(text).replace(` [${d.asyncId}]`, "");
  const c = new Container();
  c.addChild(new TruncatedText(`${prefix}[${d.asyncId.slice(0, 8)}] ${headline}`));
  c.addChild(new TruncatedText(theme.fg("dim", `${keyText("app.tools.expand")} details`)));
  return c;
}
function compactText(text: string, prefix: string, theme: Theme): Component {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length === 1) {
    return new Text(truncLine(`${prefix}${lines[0] ?? ""}`, getTermWidth() - 4), 0, 0);
  }
  const visible = lines.slice(0, 12),
    expand = keyText("app.tools.expand");
  if (lines.length > visible.length) {
    visible.push(
      theme.fg(
        "dim",
        `+${lines.length - visible.length} more${hasText(expand) ? ` · ${expand} expands` : ""}`,
      ),
    );
  }
  return new Text(`${prefix}${visible.join("\n")}`, 0, 0);
}
function textResult(result: Result, expanded: boolean, theme: Theme, isError: boolean): Component {
  const d = result.details,
    first = result.content.at(0),
    text = first?.type === "text" ? first.text : "(no output)";
  const prefix = d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
  if (expanded) {
    return new Text(`${prefix}${text}`, 0, 0);
  }
  const receipt = isError ? undefined : asyncReceipt(d, text, prefix, theme);
  return receipt ?? compactText(text, prefix, theme);
}
function singleResult(d: DetailsInput): boolean {
  return d.mode === "single" && d.results.length === 1;
}
function expandedResult(
  result: Result,
  d: DetailsInput,
  theme: Theme,
  isError: boolean,
): Component {
  const facts = workflowFacts(d, isError),
    showRun = isError || facts.failed || facts.blocked || facts.paused;
  const receipt =
    showRun || d.intercomDelivery?.delivered === true
      ? result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : undefined;
  const settings = { isError, showRun, receipt },
    first = d.results.at(0);
  if (singleResult(d) && first) {
    return renderSingleExpanded(d, first, theme, settings);
  }
  return renderMultiExpanded(d, theme, settings);
}
export function renderSubagentResult(
  result: Result,
  options: { readonly expanded: boolean },
  theme: Theme,
  context?: { readonly isError: boolean },
): Component {
  const isError = context?.isError ?? result.isError ?? false,
    d = result.details;
  if (!d || d.results.length === 0) {
    return textResult(result, options.expanded, theme, isError);
  }
  if (options.expanded) {
    return expandedResult(result, d, theme, isError);
  }
  const first = d.results.at(0);
  return singleResult(d) && first
    ? renderSingleCompact(d, first, theme, isError)
    : renderMultiCompact(d, theme, isError);
}
