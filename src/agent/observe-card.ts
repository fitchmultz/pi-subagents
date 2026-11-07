import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { isRecord } from "../shared/unknown.ts";
import type { ViewedBlock, ViewedTool } from "./observe-client.ts";
import type { ConversationPage } from "./journal-tail.ts";
import {
  AssistantMessageComponent,
  Container,
  Text,
  ToolExecutionComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "./observe-layout.ts";

export interface CardOptions {
  tui: TUI;
  cwd: string;
  hideThinking: boolean;
}
const renderers = Object.entries({
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  find: createFindToolDefinition,
  grep: createGrepToolDefinition,
  ls: createLsToolDefinition,
  powershell: createPowerShellToolDefinition,
  read: createReadToolDefinition,
  write: createWriteToolDefinition,
});
function nativeTool(
  name: string,
  id: string,
  args: unknown,
  options: CardOptions,
): InstanceType<typeof ToolExecutionComponent> {
  return new ToolExecutionComponent(
    name,
    id,
    args,
    { showImages: false, outputPad: 0 },
    renderers.find(([key]) => key === name)?.[1](options.cwd) ?? {},
    options.tui,
    options.cwd,
  );
}

export function blocks(value: unknown): ViewedBlock[] {
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return (value as unknown[]).flatMap((part): ViewedBlock[] => {
    if (!isRecord(part)) {
      return [];
    }
    if (part.type === "text" && typeof part.text === "string") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "thinking" && typeof part.thinking === "string") {
      return [{ type: "thinking", text: part.thinking }];
    }
    if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
      return [{ type: "toolCall", id: part.id, name: part.name, args: part.arguments }];
    }
    return [
      {
        type: "text",
        text: `[${typeof part.type === "string" ? part.type : "non-text"} attachment]`,
      },
    ];
  });
}
export function projected(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return "json" in value ? value.json : undefined;
}
export function assistant(content: ViewedBlock[], streaming: boolean): AssistantMessage {
  // Rendering only. Accounting and completion still use native journals and receipts.
  return {
    role: "assistant",
    api: "observer",
    provider: "observer",
    model: "",
    timestamp: 0,
    stopReason: streaming ? "pending" : "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: content.flatMap((block): AssistantMessage["content"] => {
      if (block.type === "thinking") {
        return [{ type: "thinking", thinking: block.text ?? "" }];
      }
      return block.type === "text" ? [{ type: "text", text: block.text ?? "" }] : [];
    }),
  };
}

type ToolPhase = "Preparing tool call" | "Running" | "Awaiting journal publication";
type LiveContent =
  | {
      readonly kind: "assistant";
      readonly component: InstanceType<typeof AssistantMessageComponent>;
      readonly status: InstanceType<typeof Text>;
      readonly blocks: ViewedBlock[];
      readonly ended: boolean;
    }
  | {
      readonly kind: "tool";
      readonly component: InstanceType<typeof ToolExecutionComponent>;
      readonly status: InstanceType<typeof Text>;
      arguments: unknown;
      progress:
        | { readonly kind: "unseen" }
        | { readonly kind: "shown"; readonly value: unknown; readonly phase: ToolPhase };
    };
type CardDisplay =
  | { readonly kind: "loading" }
  | { readonly kind: "live"; readonly preview: LiveContent }
  | {
      readonly kind: "published";
      readonly page: number;
      readonly pages: number;
      readonly tool: InstanceType<typeof ToolExecutionComponent> | undefined;
    };
type CardContent = CardDisplay | { readonly kind: "unavailable"; readonly previous: CardDisplay };

export class Card implements Component {
  id: string;
  private readonly content = new Container();
  readonly footer = new Container();
  selected = false;
  expanded = false;
  private state: CardContent = { kind: "loading" };
  private cache?: { width: number; lines: string[] } | undefined;
  constructor(id: string) {
    this.id = id;
    this.content.addChild(new Text("Loading published content…", 0, 0));
  }
  private get display(): CardDisplay {
    return this.state.kind === "unavailable" ? this.state.previous : this.state;
  }
  get ready(): boolean {
    return this.display.kind === "published";
  }
  get page(): number {
    const display = this.display;
    return display.kind === "published" ? display.page : 0;
  }
  get pages(): number {
    const display = this.display;
    return display.kind === "published" ? display.pages : 1;
  }
  get tool(): InstanceType<typeof ToolExecutionComponent> | undefined {
    const display = this.display;
    if (display.kind === "published") {
      return display.tool;
    }
    return display.kind === "live" && display.preview.kind === "tool"
      ? display.preview.component
      : undefined;
  }
  private setLive(preview: LiveContent): void {
    const display: CardDisplay = { kind: "live", preview };
    this.state =
      this.state.kind === "unavailable" ? { kind: "unavailable", previous: display } : display;
  }
  unavailable(message: string): void {
    this.state = { kind: "unavailable", previous: this.display };
    this.footer.clear();
    this.footer.addChild(new Text(`Content unavailable: ${message}`, 0, 0));
    this.invalidate();
  }
  publish(page: ConversationPage, args: unknown, options: CardOptions): void {
    const previousTool = this.tool;
    this.content.clear();
    this.footer.clear();
    const { message } = page;
    const content = blocks(message.content);
    let tool: InstanceType<typeof ToolExecutionComponent> | undefined;
    if (message.role === "assistant") {
      this.content.addChild(
        new AssistantMessageComponent(assistant(content, false), options.hideThinking),
      );
      if (typeof message.errorMessage === "string") {
        this.content.addChild(new Text(message.errorMessage, 0, 0));
      }
    } else if (message.role === "toolResult") {
      tool = this.publishTool(message, args, options, previousTool);
    } else {
      this.content.addChild(
        new Text(
          `${typeof message.role === "string" ? message.role : "message"}\n${content.map((part) => part.text ?? "").join("\n")}`,
          0,
          0,
        ),
      );
    }
    this.state = { kind: "published", page: page.page, pages: page.pages, tool };
    this.cache = undefined;
  }
  private publishTool(
    message: Record<string, unknown>,
    args: unknown,
    options: CardOptions,
    previous: InstanceType<typeof ToolExecutionComponent> | undefined,
  ): InstanceType<typeof ToolExecutionComponent> {
    const tool =
      previous ??
      nativeTool(
        typeof message.toolName === "string" ? message.toolName : "tool",
        typeof message.toolCallId === "string" ? message.toolCallId : this.id,
        args ?? {},
        options,
      );
    tool.updateResult({
      content: blocks(message.content)
        .filter((part) => part.type === "text")
        .map((part) =>
          part.text === undefined ? { type: "text" } : { type: "text", text: part.text },
        ),
      isError: message.isError === true,
    });
    tool.setExpanded(this.expanded);
    this.content.addChild(tool);
    this.footer.addChild(
      new Text("Arguments are a bounded preview. Exact call in Details journal.", 0, 0),
    );
    return tool;
  }
  private configureTool(
    value: ViewedTool,
    options: CardOptions,
  ): Extract<LiveContent, { kind: "tool" }> {
    const display = this.display;
    if (display.kind === "live" && display.preview.kind === "tool") {
      return display.preview;
    }
    const component =
      this.tool ?? nativeTool(value.name, value.id, projected(value.args) ?? {}, options);
    component.setExpanded(this.expanded);
    const status = new Text("", 0, 0);
    this.content.clear();
    this.content.addChild(component);
    this.content.addChild(status);
    const live: Extract<LiveContent, { kind: "tool" }> = {
      kind: "tool",
      component,
      status,
      arguments: value.args,
      progress: { kind: "unseen" },
    };
    this.setLive(live);
    this.cache = undefined;
    return live;
  }
  updateTool(value: ViewedTool, options: CardOptions, preparing: boolean): void {
    const live = this.configureTool(value, options);
    const ended = value.end !== undefined;
    const source = value.end ?? { result: value.partial, isError: false };
    let phase: ToolPhase = preparing ? "Preparing tool call" : "Running";
    if (ended) {
      phase = "Awaiting journal publication";
    }
    if (live.arguments !== value.args) {
      live.component.updateArgs(projected(value.args) ?? {});
      live.arguments = value.args;
      this.cache = undefined;
    }
    if (
      live.progress.kind === "unseen" ||
      live.progress.value !== source.result ||
      live.progress.phase !== phase
    ) {
      if (source.result !== undefined) {
        this.preview(live.component, source.result, source.isError, !ended);
      }
      live.status.setText(phase);
      live.progress = { kind: "shown", value: source.result, phase };
      this.cache = undefined;
    }
  }
  private preview(
    tool: InstanceType<typeof ToolExecutionComponent>,
    value: unknown,
    isError: boolean,
    partial: boolean,
  ): void {
    const result = projected(value) ?? {
      content: [
        { type: "text", text: "Live preview unavailable; full result appears after publication." },
      ],
    };
    if (isRecord(result)) {
      tool.updateResult(
        {
          content: blocks(result.content)
            .filter((part) => part.type === "text")
            .map((part) =>
              part.text === undefined ? { type: "text" } : { type: "text", text: part.text },
            ),
          isError,
        },
        partial,
      );
    }
  }
  stream(message: { blocks: ViewedBlock[]; ended: boolean }, hideThinking: boolean): void {
    const display = this.display;
    const live =
      display.kind === "live" && display.preview.kind === "assistant" ? display.preview : undefined;
    if (live && this.matches(live, message.blocks, message.ended)) {
      return;
    }
    const { component, status } = live ?? {
      component: new AssistantMessageComponent(undefined, hideThinking),
      status: new Text("", 0, 0),
    };
    if (!live) {
      this.content.clear();
      this.content.addChild(component);
      this.content.addChild(status);
    }
    component.updateContent(
      assistant(message.blocks.filter(Boolean), !message.ended),
      !message.ended,
    );
    status.setText(message.ended ? "Awaiting journal publication" : "In progress");
    this.setLive({
      kind: "assistant",
      component,
      status,
      blocks: message.blocks.slice(),
      ended: message.ended,
    });
    this.cache = undefined;
  }
  invalidate(): void {
    this.cache = undefined;
    this.content.invalidate();
    this.footer.invalidate();
  }
  render(width: number): string[] {
    if (this.cache?.width !== width) {
      const lines = [...this.content.render(width), ...this.footer.render(width)];
      if (this.selected && this.tool && lines.length > 0) {
        lines[0] = "> Selected tool".slice(0, width);
      }
      this.cache = { width, lines };
    }
    return this.cache.lines;
  }
  private matches(
    live: Extract<LiveContent, { kind: "assistant" }>,
    content: ViewedBlock[],
    ended: boolean,
  ): boolean {
    return (
      live.ended === ended &&
      live.blocks.length === content.length &&
      content.every((block, index) => live.blocks[index] === block)
    );
  }
  toggle(): void {
    const tool = this.tool;
    if (tool) {
      this.expanded = !this.expanded;
      tool.setExpanded(this.expanded);
      this.cache = undefined;
    }
  }
  handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
    const body = this.content.render(event.width).length;
    if (event.y >= body) {
      return this.footer.handleMouse({
        ...event,
        y: event.y - body,
        height: Math.max(0, event.height - body),
      });
    }
    if (
      this.tool &&
      event.button === "left" &&
      (event.type === "press" || event.type === "click")
    ) {
      if (event.type === "click") {
        this.toggle();
      }
      return { handled: true, render: event.type === "click" };
    }
    const result = this.content.handleMouse(event);
    if (result?.handled) {
      this.cache = undefined;
    }
    return result;
  }
}
