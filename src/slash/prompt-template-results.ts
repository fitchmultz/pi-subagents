import { isRecord, isUnknownArray } from "../shared/unknown.ts";
import type {
  DelegationTask,
  DelegationResultItem,
  DelegationParallelResult,
  DelegationProgress,
  DelegationRequest,
  DelegationResponse,
  DelegationResult,
} from "./prompt-template-contract.ts";

interface TaskProgress {
  readonly index?: number;
  readonly agent: string;
  readonly status?: string;
  readonly currentTool?: string;
  readonly currentToolArgs?: string;
  readonly recentOutput?: string;
  readonly recentOutputLines?: readonly string[];
  readonly recentTools?: readonly { readonly tool: string; readonly args: string }[];
  readonly model?: string;
  readonly toolCount?: number;
  readonly durationMs?: number;
  readonly tokens?: number;
}

interface DelegationUpdate extends Omit<TaskProgress, "agent" | "index" | "status"> {
  readonly requestId: string;
  readonly taskProgress?: readonly TaskProgress[];
}

function firstTextContent(content: unknown): string | undefined {
  if (!isUnknownArray(content)) {
    return undefined;
  }
  for (const part of content) {
    if (
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0
    ) {
      return part.text.trim();
    }
  }
  return undefined;
}

function recentOutput(lines: readonly unknown[] | undefined): readonly string[] | undefined {
  const filtered = lines?.filter(
    (line): line is string =>
      typeof line === "string" && line.trim().length > 0 && line.trim() !== "(running...)",
  );
  return filtered !== undefined && filtered.length > 0 ? filtered : undefined;
}

function lastOutput(lines: readonly unknown[] | undefined): string | undefined {
  const last = lines?.at(-1);
  return typeof last === "string" && last.trim().length > 0 && last !== "(running...)"
    ? last
    : undefined;
}

function recentTools(tools: DelegationProgress["recentTools"]): TaskProgress["recentTools"] {
  const sanitized = tools?.flatMap((entry) => {
    if (entry.tool === undefined || entry.tool.trim().length === 0) {
      return [];
    }
    return [{ tool: entry.tool, args: entry.args ?? "" }];
  });
  return sanitized !== undefined && sanitized.length > 0 ? sanitized : undefined;
}

function nonemptyModel(
  result: DelegationResultItem | undefined,
): result is DelegationResultItem & { readonly model: string } {
  return result?.model !== undefined && result.model.length > 0;
}

function progressModel(result: DelegationResult, entry: DelegationProgress): string | undefined {
  const results = result.details?.results ?? [];
  if (entry.index !== undefined && entry.index >= 0) {
    const model = results.at(entry.index)?.model;
    if (model !== undefined) {
      return model;
    }
  }
  if (entry.agent !== undefined && entry.agent.length > 0) {
    const byAgent = results.find((item) => item.agent === entry.agent && item.model !== undefined);
    if (nonemptyModel(byAgent)) {
      return byAgent.model;
    }
  }
  return results.find((item) => item.model !== undefined)?.model;
}

function taskProgress(result: DelegationResult, entry: DelegationProgress): TaskProgress {
  return {
    index: entry.index,
    agent: entry.agent ?? "delegate",
    status: entry.status,
    currentTool: entry.currentTool,
    currentToolArgs: entry.currentToolArgs,
    recentOutput: lastOutput(entry.recentOutput),
    recentOutputLines: recentOutput(entry.recentOutput),
    recentTools: recentTools(entry.recentTools),
    model: progressModel(result, entry),
    toolCount: entry.toolCount,
    durationMs: entry.durationMs,
    tokens: entry.tokens,
  };
}

export function delegationUpdate(
  requestId: string,
  result: DelegationResult,
): DelegationUpdate | undefined {
  const entries = result.details?.progress;
  const first = entries?.at(0);
  if (!first) {
    return undefined;
  }
  const { agent: _agent, index: _index, status: _status, ...top } = taskProgress(result, first);
  return {
    requestId,
    ...top,
    taskProgress: entries?.map((entry) => taskProgress(result, entry)),
  };
}

function messages(result: DelegationResultItem, fallback?: string): readonly unknown[] {
  if (result.messages !== undefined && result.messages.length > 0) {
    return result.messages;
  }
  const text =
    result.finalOutput !== undefined && result.finalOutput.trim().length > 0
      ? result.finalOutput.trim()
      : fallback;
  return text !== undefined && text.length > 0
    ? [{ role: "assistant", content: [{ type: "text", text }] }]
    : [];
}

function parallelResult(
  task: DelegationTask,
  step: DelegationResultItem | undefined,
): DelegationParallelResult {
  if (!step) {
    return {
      agent: task.agent,
      messages: [],
      isError: true,
      errorText: "Missing result for delegated parallel task.",
    };
  }
  const errorText = step.error;
  return {
    agent: step.agent ?? task.agent,
    messages: messages(step),
    isError:
      (step.exitCode !== undefined && step.exitCode !== 0) ||
      (errorText !== undefined && errorText.length > 0),
    errorText: errorText !== undefined && errorText.length > 0 ? errorText : undefined,
  };
}

export function delegationResponse(
  request: DelegationRequest,
  result: DelegationResult,
): DelegationResponse {
  const contentText = firstTextContent(result.content);
  const parallelResults = request.tasks?.map((task, index) =>
    parallelResult(task, result.details?.results?.at(index)),
  );
  return {
    ...request,
    messages: messages(result.details?.results?.at(0) ?? {}, contentText),
    ...(parallelResults ? { parallelResults } : {}),
    ...(contentText !== undefined ? { contentText } : {}),
    isError: result.isError === true,
    errorText: result.isError === true ? contentText : undefined,
  };
}
