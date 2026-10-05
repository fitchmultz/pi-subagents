import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  normalizeSubagentParamsLike,
  type SubagentParamsLike,
  type SubagentExecutionRequest,
} from "../runs/foreground/subagent-executor.ts";
import { errorMessage, isRecord } from "../shared/unknown.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import {
  SLASH_SUBAGENT_CANCEL_EVENT,
  SLASH_SUBAGENT_REQUEST_EVENT,
  SLASH_SUBAGENT_RESPONSE_EVENT,
  SLASH_SUBAGENT_STARTED_EVENT,
  SLASH_SUBAGENT_UPDATE_EVENT,
  type Details,
  type SubagentExecutionResult,
} from "../shared/types.ts";

interface SlashSubagentRequest {
  readonly requestId: string;
  readonly params: ReadonlyInput<SubagentParamsLike>;
  /** Reuse slash discovery's captured directory without changing the native session context. */
  readonly executionCwd?: string;
}

export interface SlashSubagentResponse {
  readonly requestId: string;
  readonly result: ReadonlyInput<SubagentExecutionResult>;
  readonly isError: boolean;
  readonly errorText?: string;
}

export interface SlashSubagentUpdate {
  readonly requestId: string;
  readonly progress?: ReadonlyInput<Details["progress"]>;
  readonly currentTool?: string;
  readonly toolCount?: number;
}

interface EventBus {
  // Retained adapter buses may return no unsubscribe function, including an explicit void contract.
  // oxlint-disable-next-line typescript/no-invalid-void-type
  readonly on: (event: string, handler: (data: unknown) => void) => (() => void) | void;
  readonly emit: (event: string, data: unknown) => void;
}

interface SlashBridgeOptions {
  readonly events: EventBus;
  readonly getContext: () => ExtensionContext | null;
  readonly execute: (request: SubagentExecutionRequest) => Promise<SubagentExecutionResult>;
}

function failedResponse(
  requestId: string,
  errorText: string,
  content = errorText,
): SlashSubagentResponse {
  return {
    requestId,
    isError: true,
    errorText,
    result: {
      content: [{ type: "text", text: content }],
      details: { mode: "single", results: [] },
    },
  };
}

class SlashBridge {
  private readonly options: SlashBridgeOptions;
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingCancels = new Set<string>();
  private readonly subscriptions: Array<() => void> = [];
  private readonly pending = new Set<Promise<void>>();

  constructor(options: SlashBridgeOptions) {
    this.options = options;
  }

  register(): void {
    this.subscribe(SLASH_SUBAGENT_CANCEL_EVENT, (data) => this.cancel(data));
    this.subscribe(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
      const operation = this.receive(data);
      this.pending.add(operation);
      operation
        .finally(() => {
          this.pending.delete(operation);
        })
        .catch((error: unknown) => {
          console.error("Slash subagent bridge failed:", error);
        });
    });
  }

  private subscribe(event: string, handler: (data: unknown) => void): void {
    const unsubscribe = this.options.events.on(event, handler);
    if (typeof unsubscribe === "function") {
      this.subscriptions.push(unsubscribe);
    }
  }

  private cancel(data: unknown): void {
    if (!isRecord(data) || typeof data.requestId !== "string") {
      return;
    }
    const controller = this.controllers.get(data.requestId);
    if (controller) {
      controller.abort();
    } else {
      this.pendingCancels.add(data.requestId);
    }
  }

  private respond(response: SlashSubagentResponse): void {
    this.options.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, response);
  }

  private async receive(data: unknown): Promise<void> {
    if (!isRecord(data) || typeof data.requestId !== "string" || data.params === undefined) {
      return;
    }
    const requestId = data.requestId;
    const ctx = this.options.getContext();
    if (!ctx) {
      this.respond(
        failedResponse(
          requestId,
          "No active extension context.",
          "No active extension context for slash subagent execution.",
        ),
      );
      return;
    }
    if (!isRecord(data.params)) {
      this.respond(failedResponse(requestId, "Slash subagent parameters must be an object."));
      return;
    }
    const request: SlashSubagentRequest = {
      requestId,
      params: normalizeSubagentParamsLike(data.params),
      ...(typeof data.executionCwd === "string" ? { executionCwd: data.executionCwd } : {}),
    };
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    if (this.pendingCancels.delete(requestId)) {
      controller.abort();
      this.respond(failedResponse(requestId, "Cancelled before start.", "Cancelled."));
      this.controllers.delete(requestId);
      return;
    }
    this.options.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
    await this.execute(request, controller.signal, ctx);
  }

  private async execute(
    request: SlashSubagentRequest,
    signal: AbortSignal,
    ctx: ExtensionContext,
  ): Promise<void> {
    try {
      const result = await this.options.execute({
        toolCallId: request.requestId,
        params: request.params,
        signal,
        onUpdate: (update) => {
          const progress = update.details.progress;
          const first = progress?.at(0);
          this.options.events.emit(SLASH_SUBAGENT_UPDATE_EVENT, {
            requestId: request.requestId,
            progress,
            currentTool: first?.currentTool,
            toolCount: first?.toolCount,
          });
        },
        ctx,
        executionCwd: request.executionCwd,
      });
      this.respond({
        requestId: request.requestId,
        result,
        isError: result.isError === true,
        errorText:
          result.isError === true
            ? result.content.find((part) => part.type === "text")?.text
            : undefined,
      });
    } catch (error) {
      this.respond(failedResponse(request.requestId, errorMessage(error)));
    } finally {
      this.controllers.delete(request.requestId);
    }
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.pendingCancels.clear();
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions.length = 0;
    this.pendingCancels.clear();
  }
}

export function registerSlashSubagentBridge(options: SlashBridgeOptions): {
  cancelAll: () => void;
  dispose: () => void;
} {
  const bridge = new SlashBridge(options);
  bridge.register();
  return { cancelAll: () => bridge.cancelAll(), dispose: () => bridge.dispose() };
}
