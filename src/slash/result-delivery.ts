import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { ReadonlyInput } from "../shared/types/inputs.ts";
import { errorMessage, isRecord } from "../shared/unknown.ts";
import { isTuiContext } from "../shared/ui-mode.ts";
import {
  SLASH_RESULT_TYPE,
  SLASH_SUBAGENT_CANCEL_EVENT,
  SLASH_SUBAGENT_REQUEST_EVENT,
  SLASH_SUBAGENT_RESPONSE_EVENT,
  SLASH_SUBAGENT_STARTED_EVENT,
  SLASH_SUBAGENT_UPDATE_EVENT,
  type SingleResult,
} from "../shared/types.ts";
import type { SlashSubagentResponse } from "./slash-bridge.ts";
import {
  applySlashUpdate,
  buildSlashInitialResult,
  failSlashResult,
  finalizeSlashResult,
} from "./slash-live-state.ts";
import { slashResponse, slashUpdate } from "./request-protocol.ts";

interface RequestCallbacks {
  readonly active: () => boolean;
  readonly started: () => void;
  readonly response: (response: ReadonlyInput<SlashSubagentResponse>) => void;
  readonly failed: (error: Readonly<Error>) => void;
}

function subscribeRequest(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requestId: string,
  callbacks: RequestCallbacks,
): () => void {
  const started = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, (data) => {
    if (callbacks.active() && isRecord(data) && data.requestId === requestId) {
      callbacks.started();
      if (ctx.hasUI) {
        ctx.ui.setStatus("subagent-slash", "running...");
      }
    }
  });
  const response = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, (data) => {
    if (!callbacks.active()) {
      return;
    }
    try {
      const parsed = slashResponse(data, requestId);
      if (parsed) {
        callbacks.response(parsed);
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      callbacks.failed(error);
    }
  });
  const update = pi.events.on(SLASH_SUBAGENT_UPDATE_EVENT, (data) => {
    if (!callbacks.active()) {
      return;
    }
    const parsed = slashUpdate(data, requestId);
    if (!parsed) {
      return;
    }
    applySlashUpdate(requestId, parsed);
    if (ctx.hasUI) {
      const tool = parsed.currentTool ?? "";
      ctx.ui.setStatus(
        "subagent-slash",
        `${parsed.toolCount ?? 0} tools${tool.length > 0 ? ` ${tool}` : ""}`,
      );
    }
  });
  const terminal = isTuiContext(ctx)
    ? ctx.ui.onTerminalInput((input) => {
        if (!callbacks.active() || !matchesKey(input, Key.escape)) {
          return;
        }
        pi.events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId });
        callbacks.failed(new Error("Cancelled"));
        return { consume: true };
      })
    : undefined;
  return () => {
    started();
    response();
    update();
    terminal?.();
  };
}

class PendingSlashRequest {
  private readonly pending = Promise.withResolvers<SlashSubagentResponse>();
  private readonly timer: ReturnType<typeof setTimeout>;
  private started = false;
  private settled = false;

  constructor() {
    this.timer = setTimeout(
      () =>
        this.fail(
          new Error(
            "Slash subagent bridge did not start within 15s. Ensure the extension is loaded correctly.",
          ),
        ),
      15_000,
    );
  }

  active(): boolean {
    return !this.settled;
  }
  admitted(): boolean {
    return this.started;
  }
  result(): Promise<SlashSubagentResponse> {
    return this.pending.promise;
  }
  start(): void {
    this.started = true;
    clearTimeout(this.timer);
  }
  respond(response: ReadonlyInput<SlashSubagentResponse>): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    clearTimeout(this.timer);
    this.pending.resolve(response);
  }
  fail(error: Readonly<Error>): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.pending.reject(error);
  }
  dispose(): void {
    clearTimeout(this.timer);
  }
}

async function requestSlashRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  request: {
    readonly requestId: string;
    readonly params: ReadonlyInput<SubagentParamsLike>;
    readonly executionCwd?: string;
  },
): Promise<SlashSubagentResponse> {
  const pending = new PendingSlashRequest();
  let dispose: (() => void) | undefined;
  try {
    dispose = subscribeRequest(pi, ctx, request.requestId, {
      active: () => pending.active(),
      started: () => {
        pending.start();
      },
      response: (response) => {
        pending.respond(response);
      },
      failed: (error) => {
        pending.fail(error);
      },
    });
    try {
      pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, request);
    } catch (error) {
      // A synchronous response may have already settled before a later bus listener fails.
      if (!pending.active()) {
        return await pending.result();
      }
      throw error;
    }
    // STARTED is synchronous: its absence means no bridge admitted this request.
    if (!pending.admitted() && pending.active()) {
      pending.fail(
        new Error(
          "No slash subagent bridge responded. Ensure the subagent extension is loaded correctly.",
        ),
      );
    }
    return await pending.result();
  } finally {
    pending.dispose();
    dispose?.();
  }
}

function messageText(content: ReadonlyInput<SlashSubagentResponse["result"]["content"]>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function resultPaths(
  results: ReadonlyInput<SingleResult[]>,
  getPath: (result: ReadonlyInput<SingleResult>) => string | undefined,
): string[] {
  return results
    .map(getPath)
    .filter((file): file is string => file !== undefined && file.length > 0);
}

function fallbackText(text: string): string {
  return text.length > 0 ? text : "(no output)";
}

function exportText(response: SlashSubagentResponse): string {
  const output = messageText(response.result.content);
  const results = response.result.details.results;
  const fallback = response.errorText ?? "";
  const sections = ["## Subagent result", output.length > 0 ? output : fallbackText(fallback)];
  for (const [title, paths] of [
    ["Child session exports", resultPaths(results, (result) => result.sessionFile)],
    ["Saved outputs", resultPaths(results, (result) => result.savedOutputPath)],
    ["Artifact outputs", resultPaths(results, (result) => result.artifactPaths?.outputPath)],
  ] as const) {
    if (paths.length > 0) {
      sections.push(`## ${title}`, paths.map((file) => `- \`${file}\``).join("\n"));
    }
  }
  return sections.join("\n\n");
}

function finishSlashStatus(
  ctx: ExtensionContext,
  response: ReadonlyInput<SlashSubagentResponse>,
): void {
  if (!ctx.hasUI) {
    return;
  }
  ctx.ui.setStatus("subagent-slash", undefined);
  if (response.isError) {
    const error = response.errorText ?? "";
    ctx.ui.notify(error.length > 0 ? error : "Subagent failed", "error");
  }
}

export async function runSlashSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: ReadonlyInput<SubagentParamsLike>,
  executionCwd?: string,
): Promise<void> {
  const requestId = randomUUID();
  const initialDetails = buildSlashInitialResult(requestId, params);
  const text = messageText(initialDetails.result.content);
  pi.sendMessage({
    customType: SLASH_RESULT_TYPE,
    content: text.length > 0 ? text : "Running subagent...",
    display: true,
    details: initialDetails,
  });
  try {
    const response = await requestSlashRun(pi, ctx, {
      requestId,
      params,
      ...(executionCwd !== undefined && executionCwd.length > 0 ? { executionCwd } : {}),
    });
    const finalDetails = finalizeSlashResult(response);
    pi.sendMessage({
      customType: SLASH_RESULT_TYPE,
      content: exportText(response),
      display: false,
      details: finalDetails,
    });
    finishSlashStatus(ctx, response);
  } catch (error) {
    const message = errorMessage(error);
    pi.sendMessage({
      customType: SLASH_RESULT_TYPE,
      content: `## Subagent result\n\n${message}`,
      display: false,
      details: failSlashResult(requestId, params, message),
    });
    if (ctx.hasUI) {
      ctx.ui.setStatus("subagent-slash", undefined);
      ctx.ui.notify(message, message === "Cancelled" ? "warning" : "error");
    }
  }
}
