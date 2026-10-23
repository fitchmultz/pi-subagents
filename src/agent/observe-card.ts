import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Container,
  Text,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { isRecord } from "../shared/unknown.ts";
import type { ViewedBlock, ViewedTool } from "./observe-client.ts";
import type { ConversationPage } from "./journal-tail.ts";

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
): ToolExecutionComponent {
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

export class Card implements Component {
  id: string;
  readonly content = new Container();
  readonly footer = new Container();
  assistant?: AssistantMessageComponent;
  status?: Text;
  blocks?: ViewedBlock[];
  ended?: boolean;
  value?: unknown;
  tool?: ToolExecutionComponent;
  selected = false;
  expanded = false;
  ready = false;
  page = 0;
  pages = 1;
  private cache?: { width: number; lines: string[] };
  private arguments?: unknown;
  private phase = "";
  constructor(id: string) {
    this.id = id;
  }
  publish(page: ConversationPage, args: unknown, options: CardOptions): void {
    this.content.clear();
    this.footer.clear();
    this.ready = true;
    this.page = page.page;
    this.pages = page.pages;
    const { message } = page;
    const content = blocks(message.content);
    if (message.role === "assistant") {
      this.content.addChild(
        new AssistantMessageComponent(assistant(content, false), options.hideThinking),
      );
      if (typeof message.errorMessage === "string") {
        this.content.addChild(new Text(message.errorMessage, 0, 0));
      }
    } else if (message.role === "toolResult") {
      this.publishTool(message, args, options);
    } else {
      this.content.addChild(
        new Text(
          `${typeof message.role === "string" ? message.role : "message"}\n${content.map((part) => part.text ?? "").join("\n")}`,
          0,
          0,
        ),
      );
    }
  }
  private publishTool(message: Record<string, unknown>, args: unknown, options: CardOptions): void {
    this.tool ??= nativeTool(
      typeof message.toolName === "string" ? message.toolName : "tool",
      typeof message.toolCallId === "string" ? message.toolCallId : this.id,
      args ?? {},
      options,
    );
    this.tool.updateResult({
      content: blocks(message.content)
        .filter((part) => part.type === "text")
        .map((part) => ({ type: "text", text: part.text })),
      isError: message.isError === true,
    });
    this.tool.setExpanded(this.expanded);
    this.content.addChild(this.tool);
    this.footer.addChild(
      new Text("Arguments are a bounded preview. Exact call in Details journal.", 0, 0),
    );
  }
  private configureTool(value: ViewedTool, options: CardOptions): void {
    if (!this.tool) {
      this.tool = nativeTool(value.name, value.id, projected(value.args) ?? {}, options);
      this.tool.setExpanded(this.expanded);
      this.content.addChild(this.tool);
      this.status = new Text("", 0, 0);
      this.content.addChild(this.status);
    }
    if (this.arguments !== value.args) {
      this.tool.updateArgs(projected(value.args) ?? {});
      this.arguments = value.args;
      this.invalidate();
    }
  }
  updateTool(value: ViewedTool, options: CardOptions, preparing: boolean): void {
    this.configureTool(value, options);
    const ended = value.end !== undefined;
    const source = value.end ?? { result: value.partial, isError: false };
    let phase = preparing ? "Preparing tool call" : "Running";
    if (ended) {
      phase = "Awaiting journal publication";
    }
    if (this.value !== source.result || this.phase !== phase) {
      if (source.result !== undefined) {
        this.preview(source.result, source.isError, !ended);
      }
      this.status?.setText(phase);
      this.phase = phase;
      this.value = source.result;
      this.ended = ended;
      this.invalidate();
    }
  }
  private preview(value: unknown, isError: boolean, partial: boolean): void {
    const result = projected(value) ?? {
      content: [
        { type: "text", text: "Live preview unavailable; full result appears after publication." },
      ],
    };
    if (isRecord(result)) {
      this.tool?.updateResult(
        {
          content: blocks(result.content)
            .filter((part) => part.type === "text")
            .map((part) => ({ type: "text", text: part.text })),
          isError,
        },
        partial,
      );
    }
  }
  stream(message: { blocks: ViewedBlock[]; ended: boolean }, hideThinking: boolean): void {
    if (!this.assistant) {
      this.assistant = new AssistantMessageComponent(undefined, hideThinking);
      this.status = new Text("", 0, 0);
      this.content.addChild(this.assistant);
      this.content.addChild(this.status);
    }
    if (this.matches(message.blocks, message.ended)) {
      return;
    }
    this.assistant.updateContent(
      assistant(message.blocks.filter(Boolean), !message.ended),
      !message.ended,
    );
    this.status?.setText(message.ended ? "Awaiting journal publication" : "In progress");
    this.blocks = message.blocks.slice();
    this.ended = message.ended;
    this.invalidate();
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
  private matches(content: ViewedBlock[], ended: boolean): boolean {
    return (
      this.ended === ended &&
      this.blocks?.length === content.length &&
      content.every((block, index) => this.blocks?.[index] === block)
    );
  }
  toggle(): void {
    if (this.tool) {
      this.expanded = !this.expanded;
      this.tool.setExpanded(this.expanded);
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
