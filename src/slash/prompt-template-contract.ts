import { isRecord, isUnknownArray } from "../shared/unknown.ts";

export interface DelegationTask {
  readonly agent: string;
  readonly task: string;
  readonly model?: string;
  readonly cwd?: string;
}

export interface DelegationRequest {
  readonly requestId: string;
  readonly agent: string;
  readonly task: string;
  readonly tasks?: readonly DelegationTask[];
  readonly context: "fresh" | "fork";
  readonly model: string;
  readonly cwd: string;
  readonly worktree?: boolean;
}

export interface DelegationParallelResult {
  readonly agent: string;
  readonly messages: readonly unknown[];
  readonly isError: boolean;
  readonly errorText?: string;
}

export interface DelegationResponse extends DelegationRequest {
  readonly messages: readonly unknown[];
  readonly parallelResults?: readonly DelegationParallelResult[];
  readonly contentText?: string;
  readonly isError: boolean;
  readonly errorText?: string;
}

export interface DelegationProgress {
  readonly index?: number;
  readonly agent?: string;
  readonly status?: string;
  readonly currentTool?: string;
  readonly currentToolArgs?: string;
  readonly recentOutput?: readonly unknown[];
  readonly recentTools?: readonly { readonly tool?: string; readonly args?: string }[];
  readonly toolCount?: number;
  readonly durationMs?: number;
  readonly tokens?: number;
}

export interface DelegationResultItem {
  readonly agent?: string;
  readonly messages?: readonly unknown[];
  readonly finalOutput?: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly model?: string;
}

export interface DelegationResult {
  readonly isError?: boolean;
  readonly content?: unknown;
  readonly details?: {
    readonly results?: readonly DelegationResultItem[];
    readonly progress?: readonly DelegationProgress[];
  };
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseTask(value: unknown): DelegationTask | undefined {
  if (!isRecord(value) || typeof value.agent !== "string" || typeof value.task !== "string") {
    return undefined;
  }
  if (value.agent.trim().length === 0 || value.task.trim().length === 0) {
    return undefined;
  }
  const model = optionalTrimmedString(value.model);
  const cwd = optionalTrimmedString(value.cwd);
  return {
    agent: value.agent,
    task: value.task,
    ...(model !== undefined ? { model } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

function parseTasks(value: unknown): DelegationTask[] {
  if (!isUnknownArray(value)) {
    return [];
  }
  const parsed: DelegationTask[] = [];
  for (const item of value) {
    const task = parseTask(item);
    if (!task) {
      return [];
    }
    parsed.push(task);
  }
  return parsed;
}

function requestHeader(
  value: Readonly<Record<string, unknown>>,
): Omit<DelegationRequest, "agent" | "task" | "tasks"> | undefined {
  const { requestId, model, cwd, context } = value;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return undefined;
  }
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    typeof cwd !== "string" ||
    cwd.length === 0
  ) {
    return undefined;
  }
  if (context !== "fresh" && context !== "fork") {
    return undefined;
  }
  return { requestId, model, cwd, context, ...(value.worktree === true ? { worktree: true } : {}) };
}

export function parseDelegationRequest(data: unknown): DelegationRequest | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const header = requestHeader(data);
  if (!header) {
    return undefined;
  }
  const tasks = parseTasks(data.tasks);
  const singleAgent = nonemptyString(data.agent);
  const singleTask = nonemptyString(data.task);
  const single =
    singleAgent !== undefined && singleTask !== undefined
      ? { agent: singleAgent, task: singleTask }
      : tasks.at(0);
  if (!single) {
    return undefined;
  }
  return {
    ...header,
    agent: single.agent,
    task: single.task,
    ...(tasks.length > 0 ? { tasks } : {}),
  };
}
