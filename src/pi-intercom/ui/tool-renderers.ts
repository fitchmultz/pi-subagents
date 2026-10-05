import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
  ContactSupervisorToolParams,
  IntercomToolParams,
  ToolRenderContext,
} from "../runtime-types.ts";
import { previewText } from "../message-format.ts";
import { firstTextContent } from "../tool-results.ts";
import { isRecord } from "../validation.ts";
interface RenderResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly details?: unknown;
}
interface RenderOptions {
  readonly expanded?: boolean;
  readonly isPartial: boolean;
}
function failed(
  context: ToolRenderContext,
  details: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return context.isError === true || details?.error === true || details?.accepted === false;
}
function contactColor(reason: string): "warning" | "muted" | "accent" {
  if (reason === "need_decision") {
    return "warning";
  }
  return reason === "progress_update" ? "muted" : "accent";
}
export function renderContactCall(args: ContactSupervisorToolParams, theme: Theme): Text {
  const reason = args.reason;
  const preview = previewText(args.message, 96);
  const interview = isRecord(args.interview) ? args.interview : undefined;
  let text =
    theme.fg("toolTitle", theme.bold("contact_supervisor ")) +
    theme.fg(contactColor(reason), reason);
  if (typeof interview?.title === "string" && interview.title.trim() !== "") {
    text += ` ${theme.fg("accent", interview.title.trim())}`;
  }
  if (preview !== undefined && preview !== "") {
    text += `\n  ${theme.fg("dim", preview)}`;
  }
  return new Text(text, 0, 0);
}
export function renderContactResult(
  result: RenderResult,
  options: RenderOptions,
  theme: Theme,
  context: ToolRenderContext,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Waiting for supervisor..."), 0, 0);
  }
  const details = isRecord(result.details) ? result.details : undefined;
  const failure = failed(context, details);
  const warning = typeof details?.structuredReplyParseError === "string";
  let prefix = theme.fg("success", "✓ ");
  if (failure) {
    prefix = theme.fg("error", "✗ ");
  } else if (warning) {
    prefix = theme.fg("warning", "⚠ ");
  }
  let text = prefix + theme.fg(failure ? "error" : "text", firstTextContent(result));
  if (typeof details?.structuredReplyParseError === "string") {
    text += `\n${theme.fg("warning", `Structured reply parse issue: ${details.structuredReplyParseError}`)}`;
  }
  return new Text(text, 0, 0);
}
function actionColor(action: IntercomToolParams["action"]): "warning" | "success" | "accent" {
  if (action === "ask") {
    return "warning";
  }
  return action === "reply" ? "success" : "accent";
}
export function renderIntercomCall(args: IntercomToolParams, theme: Theme): Text {
  const target = args.to?.trim();
  const preview = previewText(args.message, 96);
  const count = args.attachments?.length ?? 0;
  let text =
    theme.fg("toolTitle", theme.bold("intercom ")) +
    theme.fg(actionColor(args.action), args.action);
  if (target !== undefined && target !== "") {
    text += ` ${theme.fg("muted", "→")} ${theme.fg("accent", target)}`;
  }
  if (count > 0) {
    text += ` ${theme.fg("dim", `(${count} attachment${count === 1 ? "" : "s"})`)}`;
  }
  if (preview !== undefined && preview !== "") {
    text += `\n  ${theme.fg("dim", preview)}`;
  }
  return new Text(text, 0, 0);
}
function listSummary(details: Readonly<Record<string, unknown>> | undefined, theme: Theme): Text {
  const count = details?.sessionCount;
  const summary =
    typeof count === "number" ? `${count} session${count === 1 ? "" : "s"}` : "Sessions listed";
  const key = keyText("app.tools.expand");
  return new Text(
    `${theme.fg("success", "✓ ")}${theme.fg("text", summary)}${key !== "" ? ` ${theme.fg("dim", `(${key} to expand)`)}` : ""}`,
    0,
    0,
  );
}
function messageSuffix(
  details: Readonly<Record<string, unknown>> | undefined,
  expanded: boolean,
  theme: Theme,
): string {
  const id = details?.messageId;
  return typeof id === "string" && id !== "" && !expanded
    ? theme.fg("dim", ` (${id.slice(0, 8)})`)
    : "";
}
function reasonSuffix(
  details: Readonly<Record<string, unknown>> | undefined,
  expanded: boolean,
  theme: Theme,
): string {
  const reason = details?.reason;
  return typeof reason === "string" && reason !== "" && expanded
    ? `\n${theme.fg("dim", `Reason: ${reason}`)}`
    : "";
}
function renderedText(result: RenderResult, failure: boolean, theme: Theme): string {
  return (
    theme.fg(failure ? "error" : "success", failure ? "✗ " : "✓ ") +
    theme.fg(failure ? "error" : "text", firstTextContent(result))
  );
}
export function renderIntercomResult(
  result: RenderResult,
  options: RenderOptions,
  theme: Theme,
  context: ToolRenderContext,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Intercom working..."), 0, 0);
  }
  const details = isRecord(result.details) ? result.details : undefined;
  const failure = failed(context, details);
  const action = isRecord(context.args) ? context.args.action : undefined;
  if (!failure && action === "list" && options.expanded !== true) {
    return listSummary(details, theme);
  }
  const text =
    renderedText(result, failure, theme) +
    messageSuffix(details, options.expanded === true, theme) +
    reasonSuffix(details, options.expanded === true, theme);
  return new Text(text, 0, 0);
}
