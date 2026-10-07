import { errorMessage, isRecord } from "../shared/unknown.ts";
import {
  parseDelegationRequest,
  type DelegationRequest,
  type DelegationResult,
} from "./prompt-template-contract.ts";
import { delegationResponse, delegationUpdate } from "./prompt-template-results.ts";

export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";

export interface PromptTemplateBridgeEvents {
  // Retained adapter buses may return no unsubscribe function, including an explicit void contract.
  // oxlint-disable-next-line typescript/no-invalid-void-type
  readonly on: (event: string, handler: (data: unknown) => void) => (() => void) | void;
  readonly emit: (event: string, data: unknown) => void;
}

interface PromptTemplateBridgeOptions<Ctx extends { readonly cwd?: string }> {
  readonly events: PromptTemplateBridgeEvents;
  readonly getContext: () => Ctx | null;
  readonly execute: (invocation: PromptTemplateExecution<Ctx>) => Promise<DelegationResult>;
}

interface PromptTemplateExecution<Ctx extends { readonly cwd?: string }> {
  readonly request: DelegationRequest;
  readonly signal?: AbortSignal;
  readonly ctx: Ctx;
  readonly onUpdate?: (result: DelegationResult) => void;
}

class PromptTemplateBridge<Ctx extends { readonly cwd?: string }> {
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingCancels = new Set<string>();
  private readonly subscriptions: Array<() => void> = [];
  private readonly pending = new Set<Promise<void>>();

  private readonly options: PromptTemplateBridgeOptions<Ctx>;

  constructor(options: PromptTemplateBridgeOptions<Ctx>) {
    this.options = options;
  }

  register(): void {
    this.subscribe(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => this.cancel(data));
    this.subscribe(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
      const operation = this.receive(data);
      this.pending.add(operation);
      operation
        .finally(() => {
          this.pending.delete(operation);
        })
        .catch((error: unknown) => {
          console.error("Prompt template subagent bridge failed:", error);
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

  private respondError(request: DelegationRequest, errorText: string): void {
    this.options.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
      ...request,
      messages: [],
      isError: true,
      errorText,
    });
  }

  private async receive(data: unknown): Promise<void> {
    const request = parseDelegationRequest(data);
    if (!request) {
      return;
    }
    const ctx = this.options.getContext();
    if (!ctx) {
      this.respondError(request, "No active extension context for delegated subagent execution.");
      return;
    }
    const controller = new AbortController();
    this.controllers.set(request.requestId, controller);
    if (this.pendingCancels.delete(request.requestId)) {
      controller.abort();
      this.respondError(request, "Delegated prompt cancelled.");
      this.controllers.delete(request.requestId);
      return;
    }
    this.options.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
      requestId: request.requestId,
    });
    await this.execute(request, controller.signal, ctx);
  }

  private async execute(request: DelegationRequest, signal: AbortSignal, ctx: Ctx): Promise<void> {
    try {
      const result = await this.options.execute({
        request,
        signal,
        ctx,
        onUpdate: (update) => {
          const payload = delegationUpdate(request.requestId, update);
          if (payload) {
            this.options.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, payload);
          }
        },
      });
      this.options.events.emit(
        PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
        delegationResponse(request, result),
      );
    } catch (error) {
      this.respondError(request, errorMessage(error));
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

export function registerPromptTemplateDelegationBridge<Ctx extends { readonly cwd?: string }>(
  options: PromptTemplateBridgeOptions<Ctx>,
): { cancelAll: () => void; dispose: () => void } {
  const bridge = new PromptTemplateBridge(options);
  bridge.register();
  return { cancelAll: () => bridge.cancelAll(), dispose: () => bridge.dispose() };
}
