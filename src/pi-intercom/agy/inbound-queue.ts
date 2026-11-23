import { normalizeLine } from "../message-format.ts";

const MAX_SEEN_IDS = 512;
const MAX_QUEUED_INBOUND = 64;

export interface AgyHookInput {
  readonly hookEventName?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly workspacePaths?: readonly string[] | undefined;
  readonly transcriptPath?: string | undefined;
  readonly modelName?: string | undefined;
  readonly toolName?: string | undefined;
  readonly terminationReason?: string | undefined;
  readonly fullyIdle?: boolean | undefined;
}

export type AgyHookResponse =
  | { readonly decision: "allow" }
  | { readonly decision: "continue"; readonly reason: string }
  | {
      readonly injectSteps: readonly {
        readonly systemMessage: { readonly systemMessage: string };
      }[];
    }
  | Readonly<Record<string, never>>;

interface QueuedInbound {
  readonly id: string;
  readonly text: string;
}

export class AgyInboundQueue {
  private readonly items: QueuedInbound[] = [];
  private readonly seenIds = new Set<string>();

  get length(): number {
    return this.items.length;
  }

  remember(messageId: string): boolean {
    if (this.seenIds.has(messageId)) {
      return false;
    }
    this.seenIds.add(messageId);
    if (this.seenIds.size > MAX_SEEN_IDS) {
      const oldest = this.seenIds.values().next().value;
      if (oldest !== undefined) {
        this.seenIds.delete(oldest);
      }
    }
    return true;
  }

  enqueue(id: string, text: string): void {
    if (this.items.length >= MAX_QUEUED_INBOUND) {
      this.items.shift();
    }
    this.items.push({ id, text });
  }

  drain(): string | undefined {
    if (this.items.length === 0) {
      return;
    }
    const drained = this.items.splice(0, this.items.length);
    return drained.map((item) => item.text).join("\n\n---\n\n");
  }
}

export function applyHookTransition(
  input: AgyHookInput,
  queue: AgyInboundQueue,
): { readonly status?: string | undefined; readonly response: AgyHookResponse } {
  const event = input.hookEventName ?? "";
  switch (event) {
    case "SessionStart":
      return { status: "working", response: {} };
    case "PreInvocation":
    case "PostInvocation": {
      const queued = queue.drain();
      return {
        status: "working",
        response:
          queued === undefined
            ? {}
            : { injectSteps: [{ systemMessage: { systemMessage: queued } }] },
      };
    }
    case "PreToolUse": {
      const toolName = normalizeLine(input.toolName);
      return {
        status: toolName === undefined ? "working" : `tool: ${toolName}`,
        response: { decision: "allow" },
      };
    }
    case "PostToolUse":
      return { status: "working", response: {} };
    case "Stop": {
      const queued = input.terminationReason === "USER_CANCELED" ? undefined : queue.drain();
      if (queued !== undefined) {
        return { status: "working", response: { decision: "continue", reason: queued } };
      }
      return { status: "idle", response: {} };
    }
    default:
      return { response: {} };
  }
}
