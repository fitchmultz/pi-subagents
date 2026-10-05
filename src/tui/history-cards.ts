import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  UserMessageComponent,
  ToolExecutionComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  renderDiff,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { formatModelThinking } from "../shared/formatters.ts";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import { readableText, type AgentHistoryItem } from "./agent-history.ts";
import { short } from "./view-model.ts";
import { hasText } from "./text-values.ts";
interface HistoryPresentation {
  readonly selectedId?: string;
  readonly editorFocus: boolean;
  readonly detail: boolean;
  readonly toolsExpanded: boolean;
  readonly toolExpansion: Readonly<ReadonlyMap<string, boolean>>;
}
interface CachedCard {
  readonly signature: string;
  readonly item: AgentHistoryItem;
  readonly component: Component;
}
interface CardLine {
  readonly id: string;
  readonly entryIds: readonly string[];
  readonly start: number;
  readonly contentStart: number;
  readonly end: number;
}
function plainItem(item: AgentHistoryItem): boolean {
  return (
    item.load === undefined &&
    item.assistant === undefined &&
    item.previewAssistant === undefined &&
    item.call === undefined &&
    item.result === undefined
  );
}
function plainSignature(item: AgentHistoryItem): string {
  return JSON.stringify([
    item.kind,
    item.title,
    item.text,
    item.details,
    item.diff,
    item.model,
    item.timestamp,
    item.messageId,
  ]);
}
function sameDisplay(left: AgentHistoryItem, right: AgentHistoryItem): boolean {
  return plainItem(left) && plainItem(right) && plainSignature(left) === plainSignature(right);
}
function previewStop(reason: string | undefined): AssistantMessage["stopReason"] {
  if (reason === "error" || reason === "aborted" || reason === "length") {
    return reason;
  }
  return "stop";
}
/** Bounded previews/live text are native display adapters only, never journal or completion evidence. */
function assistantDisplay(item: AgentHistoryItem): AssistantMessage {
  if (item.assistant) {
    return item.assistant;
  }
  const preview = item.previewAssistant;
  return {
    role: "assistant",
    content: preview ? [...preview.content] : [{ type: "text", text: item.text }],
    timestamp: item.timestamp,
    api: "",
    provider: "",
    model: "",
    stopReason: previewStop(preview?.stopReason),
    errorMessage: preview?.errorMessage,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function sanitizedMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "text"
        ? { ...part, text: stripAcceptanceReport(readableText(part.text)) }
        : part,
    ),
  };
}

/** Native cards and width-dependent line locations have one cache owner. */
export class HistoryCards {
  lines: CardLine[] = [];
  contentItems: readonly AgentHistoryItem[] = [];
  private readonly components = new Map<string, CachedCard>();
  private readonly toolDefinitions: Map<
    string,
    ConstructorParameters<typeof ToolExecutionComponent>[4]
  >;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly cwd: () => string;
  constructor(tui: TUI, theme: Theme, cwd: () => string) {
    this.tui = tui;
    this.theme = theme;
    this.cwd = cwd;
    this.toolDefinitions = new Map(
      [
        createReadToolDefinition,
        createBashToolDefinition,
        createEditToolDefinition,
        createWriteToolDefinition,
        createFindToolDefinition,
        createGrepToolDefinition,
        createLsToolDefinition,
        createPowerShellToolDefinition,
      ].map((create) => {
        const definition = create(cwd());
        return [definition.name, definition];
      }),
    );
  }
  clear(): void {
    this.components.clear();
  }
  dispatch(id: string, event: TuiMouseEvent): void {
    this.components.get(id)?.component.handleMouse?.(event);
  }
  private prune(items: readonly AgentHistoryItem[]): void {
    const ids = new Set(items.map((item) => item.id));
    for (const id of this.components.keys()) {
      if (!ids.has(id)) {
        this.components.delete(id);
      }
    }
  }
  render(
    width: number,
    items: readonly AgentHistoryItem[],
    options: HistoryPresentation,
  ): string[] {
    this.contentItems = items;
    this.prune(items);
    this.lines = [];
    const lines: string[] = [];
    for (const item of items) {
      const expanded =
        options.detail || (options.toolExpansion.get(item.id) ?? options.toolsExpanded);
      const component = this.card(item, expanded, options.detail),
        start = lines.length;
      if (item.id === options.selectedId && !options.editorFocus) {
        lines.push(this.theme.fg("accent", short(`› ${item.title}`, width)));
      }
      const contentStart = lines.length;
      lines.push(...component.render(width));
      this.lines.push({
        id: item.id,
        entryIds: item.entryIds ?? [item.id],
        start,
        contentStart,
        end: lines.length,
      });
    }
    return lines;
  }
  private card(item: AgentHistoryItem, expanded: boolean, detail: boolean): Component {
    const signature = `${expanded}:${detail}`,
      cached = this.components.get(item.id);
    if (
      cached?.signature === signature &&
      (cached.item === item || sameDisplay(cached.item, item))
    ) {
      return cached.component;
    }
    const component = this.create(item, { expanded, detail });
    this.components.set(item.id, { signature, item, component });
    return component;
  }
  private create(
    item: AgentHistoryItem,
    presentation: { readonly expanded: boolean; readonly detail: boolean },
  ): Component {
    const c = new Container();
    if (presentation.detail && hasText(item.model)) {
      c.addChild(
        new Text(
          this.theme.fg("muted", `Message model: ${readableText(formatModelThinking(item.model))}`),
          0,
          0,
        ),
      );
    }
    c.addChild(this.body(item, presentation));
    if (presentation.detail && hasText(item.details)) {
      c.addChild(new Text(item.details, 0, 1));
    }
    c.addChild(new Spacer(1));
    return c;
  }
  private body(
    item: AgentHistoryItem,
    presentation: { readonly expanded: boolean; readonly detail: boolean },
  ): Component {
    if (item.call || item.result) {
      return this.tool(item, presentation);
    }
    if (item.kind === "assistant" || item.kind === "thinking") {
      const message = assistantDisplay(item);
      return new AssistantMessageComponent(
        presentation.detail ? message : sanitizedMessage(message),
        !presentation.detail,
        getMarkdownTheme(),
        "Thinking · open details to read",
      );
    }
    if (item.kind === "user") {
      return this.user(item);
    }
    const c = new Container();
    c.addChild(new Text(this.theme.fg("muted", readableText(item.title)), 0, 0));
    c.addChild(new Text(item.text, 0, 0));
    if (hasText(item.diff)) {
      c.addChild(new Text(renderDiff(item.diff), 0, 0));
    }
    return c;
  }
  private user(item: AgentHistoryItem): Component {
    const c = new Container();
    if (item.id.startsWith("outgoing:") || hasText(item.messageId)) {
      c.addChild(new Text(this.theme.fg("muted", item.title), 0, 0));
    }
    c.addChild(new UserMessageComponent(item.text, getMarkdownTheme(), 1));
    return c;
  }
  private tool(
    item: AgentHistoryItem,
    presentation: { readonly expanded: boolean; readonly detail: boolean },
  ): Component {
    const c = new Container(),
      call = item.call,
      result = item.result;
    if (!call && !result) {
      return c;
    }
    const name = call?.name ?? result?.toolName ?? "";
    const definition = call ? this.toolDefinitions.get(name) : undefined;
    const fallback = {
      renderCall: () =>
        new Text(this.theme.fg("toolTitle", this.theme.bold(readableText(item.title))), 0, 0),
    };
    const toolOptions = { compactView: true, showImages: false };
    const tool = new ToolExecutionComponent(
      name,
      call?.id ?? result?.toolCallId ?? "",
      call?.arguments ?? {},
      toolOptions,
      definition ?? fallback,
      this.tui,
      this.cwd(),
    );
    // Saved data only: execution/args-complete hooks would invent timing or re-read today's files.
    if (result) {
      tool.updateResult(result);
    }
    tool.setExpanded(presentation.expanded);
    c.addChild(tool);
    if (presentation.detail && hasText(item.diff) && call?.name !== "edit") {
      c.addChild(new Text(renderDiff(item.diff), 0, 0));
    }
    if (!result) {
      c.addChild(new Text(this.theme.fg("dim", "Result not recorded · exit unconfirmed"), 1, 0));
    }
    return c;
  }
}
