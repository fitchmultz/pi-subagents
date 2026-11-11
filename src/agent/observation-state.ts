import type {
  AgentSession,
  AgentSessionEvent,
  SessionMessageEntry,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { boundedJson } from "../shared/bounded-json.ts";

const VALUE_BUDGET = { bytes: 64 * 1024, nodes: 4096, depth: 32 };
/** Longer native identifiers are left to the journal rather than keyed live. */
export const NAME_CHARS = 1024;
const RETAINED = { settlements: 128, tools: 256 };

type MessageEvent = Extract<
  AgentSessionEvent,
  { type: "message_start" | "message_update" | "message_end" }
>;
export type ToolEvent = ToolExecutionStartEvent | ToolExecutionUpdateEvent | ToolExecutionEndEvent;
const WRITING = { text: "writing", thinking: "thinking", toolCall: "calling" } as const;

/** A live in-flight assistant message: a transient native reference, never a receipt. */
export interface LiveMessage {
  readonly key: number;
  readonly kind: "streaming" | "awaiting-publication";
  readonly message: AssistantMessage;
}
/** A native message found in the session tree: `[seq, entry id, live message key, tool call id]`. */
export interface Settlement {
  readonly seq: number;
  readonly json: string;
}

interface ToolProgress {
  readonly value: unknown;
  readonly rev: number;
  json?: string;
}
type ToolPhase =
  | { readonly kind: "running"; readonly progress: ToolProgress }
  | {
      readonly kind: "awaiting-publication";
      readonly progress: ToolProgress;
      readonly isError: boolean;
      readonly result: unknown;
      json?: string;
    };

export class LiveTool {
  private phase: ToolPhase = { kind: "running", progress: { value: undefined, rev: 0 } };
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  private argsJson?: string;
  constructor(id: string, name: string, args: unknown) {
    this.id = id;
    this.name = name;
    this.args = args;
  }
  get kind(): ToolPhase["kind"] {
    return this.phase.kind;
  }
  get rev(): number {
    return this.phase.progress.rev;
  }
  /** Replaceable progress: only the latest reference is projected at the next flush. */
  progress(value: unknown): void {
    if (this.phase.kind === "running") {
      this.phase = {
        kind: "running",
        progress: { value, rev: this.phase.progress.rev + 1 },
      };
    }
  }
  finish(isError: boolean, result: unknown): void {
    this.phase = { kind: "awaiting-publication", progress: this.phase.progress, isError, result };
  }
  projectedArgs(project: (value: unknown) => string): string {
    this.argsJson ??= project(this.args);
    return this.argsJson;
  }
  projectedPartial(project: (value: unknown) => string): string {
    const progress = this.phase.progress;
    progress.json ??= project(progress.value);
    return progress.json;
  }
  projectedEnd(
    project: (value: unknown) => string,
  ): { readonly isError: boolean; readonly json: string } | undefined {
    const phase = this.phase;
    if (phase.kind === "running") {
      return;
    }
    phase.json ??= project(phase.result);
    return { isError: phase.isError, json: phase.json };
  }
}

/**
 * Single-writer actor state. Sparse tool hooks always keep the tool table, because native state
 * retains neither progress, unpublished parallel results nor nested calls. Token-rate message
 * events arrive only while a detail viewer observes; attaching seeds from public native state.
 */
export class LiveState {
  version = 0;
  activityVersion = 0;
  message?: LiveMessage | undefined;
  readonly tools = new Map<string, LiveTool>();
  readonly settlements: Settlement[] = [];
  settled = 0;
  /** Live items dropped by a retention bound or a branch change; viewers resynchronize. */
  evicted = 0;
  events = 0;
  toolEvents = 0;
  progressUpdates = 0;
  projections = 0;
  unavailable = 0;
  private phase: "observing" | "unobserved" | "disposed" = "unobserved";
  private nextKey = 0;
  private settlement: "idle" | "queued" = "idle";
  private watermark: string | null;
  private readonly session: AgentSession;
  private readonly changed: () => void;
  private readonly failed: (error: unknown) => void;
  constructor(session: AgentSession, changed: () => void, failed: (error: unknown) => void) {
    this.session = session;
    this.changed = changed;
    this.failed = failed;
    this.watermark = session.sessionManager.getLeafId();
  }
  /** Start or stop the transient message view; tools persist across viewers. */
  observe(on: boolean): void {
    if (this.phase === "disposed") {
      return;
    }
    this.resolve();
    this.phase = on ? "observing" : "unobserved";
    this.message = undefined;
    this.settlements.length = 0;
    if (on) {
      const streaming = this.session.state.streamingMessage;
      if (streaming?.role === "assistant") {
        this.assistant("message_start", streaming);
      }
    }
    this.version++;
    this.activityVersion++;
  }
  apply(event: AgentSessionEvent): void {
    this.events++;
    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end"
    ) {
      this.messageEvent(event);
    }
  }
  private messageEvent(event: MessageEvent): void {
    if (event.message.role === "assistant") {
      this.assistant(event.type, event.message);
    }
    if (event.type === "message_end" && this.settlement === "idle") {
      this.settlement = "queued";
      // Native message_end listeners run just before the same job appends the entry.
      queueMicrotask(this.settle);
    }
  }
  private assistant(type: MessageEvent["type"], message: AssistantMessage): void {
    let key = this.message?.key;
    if (type === "message_start" || key === undefined) {
      // A previous message still here was never found in the session tree.
      this.evicted += key === undefined ? 0 : 1;
      key = ++this.nextKey;
    }
    this.message = {
      key,
      kind: type === "message_end" ? "awaiting-publication" : "streaming",
      message,
    };
    this.version++;
  }
  tool(event: ToolEvent): void {
    this.toolEvents++;
    this.version++;
    if (event.type === "tool_execution_start") {
      this.resolve();
      this.startTool(event.toolCallId, event.toolName, event.args);
      return;
    }
    const tool = this.tools.get(event.toolCallId);
    if (event.type === "tool_execution_update") {
      tool?.progress(event.partialResult);
      this.progressUpdates++;
    } else if (tool) {
      tool.finish(event.isError, event.result);
      this.activityVersion++;
    }
  }
  private startTool(id: string, name: string, args: unknown): void {
    if (id.length > NAME_CHARS) {
      this.unavailable++;
      return;
    }
    const oldest = this.tools.size >= RETAINED.tools ? this.tools.keys().next() : undefined;
    if (oldest?.done === false) {
      this.tools.delete(oldest.value);
      this.evicted++;
    }
    this.tools.set(id, new LiveTool(id, name, args));
    this.activityVersion++;
  }
  private readonly settle = (): void => {
    this.settlement = "idle";
    try {
      if (this.phase !== "disposed" && this.resolve()) {
        this.changed();
      }
    } catch (error) {
      this.failed(error);
    }
  };
  /**
   * Hand native messages appended since the last walk over to their session entries. A live
   * message without an entry is unresolved publication and stays live. Returns whether anything
   * changed.
   */
  resolve(): boolean {
    const { appended, departed } = this.appended();
    this.evicted += departed && this.phase === "observing" ? 1 : 0;
    for (const entry of appended) {
      this.publish(entry, !departed && this.phase === "observing");
    }
    this.settlements.splice(0, Math.max(0, this.settlements.length - RETAINED.settlements));
    const changed = appended.length > 0;
    this.version += changed ? 1 : 0;
    this.activityVersion += changed ? 1 : 0;
    return changed;
  }
  /** Message entries since the previous walk, in journal order; each append is visited once. */
  private appended(): { appended: SessionMessageEntry[]; departed: boolean } {
    const manager = this.session.sessionManager;
    const appended: SessionMessageEntry[] = [];
    let entry = manager.getLeafEntry();
    const leaf = entry?.id ?? null;
    while (entry !== undefined && entry.id !== this.watermark) {
      if (entry.type === "message") {
        appended.push(entry);
      }
      entry = entry.parentId === null ? undefined : manager.getEntry(entry.parentId);
    }
    // A leaf off the previous branch walked to the root once; its entries are not new.
    const departed = entry === undefined && this.watermark !== null;
    this.watermark = leaf;
    return { appended: appended.reverse(), departed };
  }
  private publish({ id, message }: SessionMessageEntry, settle: boolean): void {
    const call = message.role === "toolResult" ? message.toolCallId : "";
    const tool = call.length > 0 && call.length <= NAME_CHARS ? call : null;
    // A published result also retires the calls it made through ctx.executeTool().
    const retired = (key: string): boolean =>
      tool !== null && (key === tool || key.startsWith(`${tool}/`));
    for (const live of [...this.tools.keys()].filter(retired)) {
      this.tools.delete(live);
    }
    const key = this.message?.message === message ? this.message.key : null;
    this.message = key === null ? this.message : undefined;
    if (settle) {
      const seq = ++this.settled;
      this.settlements.push({ seq, json: JSON.stringify([seq, id, key, tool]) });
    }
  }
  dispose(): void {
    this.phase = "disposed";
  }
  readonly project = (value: unknown): string => {
    this.projections++;
    const result = boundedJson(value, VALUE_BUDGET);
    if ("json" in result) {
      return `{"json":${result.json}}`;
    }
    this.unavailable++;
    return `{"unavailable":"${result.unavailable}"}`;
  };
  /** Sampled from public native state, so compact peers never need token-rate events. */
  activity(busy: boolean): string {
    const { session } = this;
    const running = [...this.tools.values()].filter((tool) => tool.kind === "running");
    const streaming = session.state.streamingMessage;
    const content = streaming?.role === "assistant" ? streaming.content : undefined;
    const last = content?.at(-1)?.type;
    const phases: Array<[boolean, string]> = [
      [running.length > 0, "tool"],
      [content !== undefined, last === undefined ? "responding" : WRITING[last]],
      [session.isCompacting, "compacting"],
      [session.isRetrying, "retrying"],
      [busy || session.isStreaming, "working"],
    ];
    const phase = phases.find(([active]) => active)?.[1] ?? "idle";
    return JSON.stringify({
      phase,
      tools: running.slice(0, 3).map((tool) => tool.name.slice(0, 64)),
      running: running.length,
      model: this.session.model?.id,
      thinking: this.session.thinkingLevel,
    });
  }
}
