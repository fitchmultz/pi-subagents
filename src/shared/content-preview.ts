import { isRecord, isUnknownArray } from "./unknown.ts";

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}
function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}
function array(value: unknown): string | undefined {
  if (!isUnknownArray(value) || value.length === 0) {
    return undefined;
  }
  const first = scalar(value[0]);
  if (first === undefined || first === "") {
    return undefined;
  }
  return `${first}${value.length > 1 ? ` (+${value.length - 1} more)` : ""}`;
}
function mcpPreview(args: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof args.tool === "string" && args.tool !== "") {
    const server = typeof args.server === "string" && args.server !== "" ? `${args.server}/` : "";
    const toolArgs =
      typeof args.args === "string" && args.args !== "" ? ` ${args.args.slice(0, 40)}` : "";
    return `${server}${args.tool}${toolArgs}`;
  }
  return undefined;
}
function primaryPreview(args: Readonly<Record<string, unknown>>): string | undefined {
  const mcp = mcpPreview(args);
  if (mcp !== undefined) {
    return mcp;
  }
  const queries = array(args.queries);
  if (queries !== undefined) {
    return truncate(queries, 60);
  }
  if (typeof args.query === "string" && args.query.trim().length > 0) {
    return truncate(args.query, 60);
  }
  if (typeof args.workflow === "string" && args.workflow.trim().length > 0) {
    return `workflow=${truncate(args.workflow, 48)}`;
  }
  return undefined;
}
function secondaryPreview(args: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof args.url === "string" && args.url.trim().length > 0) {
    return truncate(args.url, 60);
  }
  const urls = array(args.urls);
  if (urls !== undefined) {
    return truncate(urls, 60);
  }
  if (typeof args.prompt === "string" && args.prompt.trim().length > 0) {
    return truncate(args.prompt, 60);
  }
  for (const key of [
    "command",
    "path",
    "file_path",
    "pattern",
    "query",
    "url",
    "task",
    "describe",
    "search",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value !== "") {
      return truncate(value, 60);
    }
  }
  return undefined;
}
/** Ordered tool-specific previews, then the first printable unknown argument. */
export function extractToolArgsPreview(args: Readonly<Record<string, unknown>>): string {
  const selected = primaryPreview(args) ?? secondaryPreview(args);
  if (selected !== undefined) {
    return selected;
  }
  for (const [key, value] of Object.entries(args)) {
    const preview = array(value);
    if (preview !== undefined) {
      return `${key}=${truncate(preview, 50)}`;
    }
    if (typeof value === "string" && value.length > 0) {
      return `${key}=${truncate(value, 50)}`;
    }
  }
  return "";
}
function partText(part: unknown): string {
  if (!isRecord(part)) {
    return "";
  }
  if (part.type === "tool_result") {
    return extractTextFromContent(part.content);
  }
  return typeof part.text === "string" ? part.text : "";
}
/** External content is accepted only as strings or known text/content fields. */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return isUnknownArray(content)
    ? content
        .map(partText)
        .filter((text) => text !== "")
        .join("\n")
    : "";
}
