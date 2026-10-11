import { isRecord } from "../../shared/unknown.ts";

interface FailedMutatingAttempt {
  readonly tool: string;
  readonly path?: string;
  readonly error: string;
  readonly ts: number;
}

interface MutatingFailureState {
  readonly consecutiveFailures: number;
  readonly lastFailureAt?: number;
  readonly recentFailures: readonly FailedMutatingAttempt[];
  readonly lastMutatingPath?: string;
  readonly repeatedPathFailures: number;
  readonly reset: () => void;
  readonly record: (input: FailedMutatingAttempt, windowMs: number) => void;
}

const MUTATING_BASH_PATTERNS = [
  /(^|[;&|()\s])rm\s+/,
  /(^|[;&|()\s])mv\s+/,
  /(^|[;&|()\s])cp\s+/,
  /(^|[;&|()\s])mkdir\s+/,
  /(^|[;&|()\s])touch\s+/,
  /(^|[;&|()\s])git\s+apply\b/,
  /(^|[;&|()\s])patch\s+/,
  /(^|[;&|()\s])sed\s+[^\n;&|]*\s-i\b/,
  /(^|[;&|()\s])perl\s+[^\n;&|]*\s-pi\b/,
  /(^|[;&|()]|\n)\s*tee\s+[^|&;]+/,
  /\b(writeFile|writeFileSync|appendFile|appendFileSync)\b/,
  /\bwrite_text\s*\(/,
  /\bopen\s*\([^)]*,\s*["'][wa]/,
];

function directPath(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["path", "file", "filename", "target", "cwd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return;
}

export function resolveCurrentPath(
  toolName: string | undefined,
  args: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (toolName === undefined || toolName === "" || !args) {
    return;
  }
  const direct = directPath(args);
  if (direct !== undefined) {
    return direct;
  }
  if (toolName === "bash" && typeof args.command === "string") {
    const redirect = args.command.match(/(?:>>?|tee\s+)\s*([^&>\s][^\s;&|]*)/);
    if (redirect?.[1] !== undefined && redirect[1] !== "") {
      return redirect[1];
    }
  }
  return;
}

function redirectionTarget(command: string, offset: number): boolean {
  if (command[offset - 1] === "-") {
    return false;
  }
  let cursor = offset + (command[offset + 1] === ">" ? 2 : 1);
  while (cursor < command.length && /\s/.test(command[cursor])) {
    cursor++;
  }
  return cursor < command.length && !["&", "|", ";", "(", ")"].includes(command[cursor]);
}

function hasUnquotedFileRedirection(command: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'" || char === '"') {
      if (quote === char) {
        quote = undefined;
      } else if (quote === undefined) {
        quote = char;
      }
      continue;
    }
    if (quote === undefined && char === ">" && redirectionTarget(command, i)) {
      return true;
    }
  }
  return false;
}

export function isMutatingBashCommand(command: string): boolean {
  return (
    hasUnquotedFileRedirection(command) ||
    MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command))
  );
}

export function isMutatingTool(
  toolName: string | undefined,
  args: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (toolName === undefined || toolName === "" || args?.preview === true) {
    return false;
  }
  if (
    ["edit", "write", "apply_edits", "apply_patch", "replace_text", "write_files"].includes(
      toolName,
    )
  ) {
    return true;
  }
  if (toolName !== "bash") {
    return false;
  }
  const command = typeof args?.command === "string" ? args.command : "";
  if (command.trim() === "") {
    return false;
  }
  return isMutatingBashCommand(command);
}

export interface PendingMutationTool {
  readonly id?: string;
  readonly tool: string;
  readonly path?: string;
  readonly mutates: boolean;
  readonly startedAt?: number;
}
export interface MutationToolResult extends PendingMutationTool {
  readonly completedMutation: boolean;
  readonly errored: boolean;
}
interface MutationStart {
  readonly id?: string;
  readonly toolName?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly path?: string;
  readonly mutates?: boolean;
  readonly startedAt?: number;
}
interface MutationEnd {
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly isError?: unknown;
  readonly details?: unknown;
}
export interface MutationCompletionTracker {
  readonly recordToolStart: (input: MutationStart) => PendingMutationTool;
  readonly recordToolResult: (input?: MutationEnd) => MutationToolResult | undefined;
}

function committedMutation(tool: string, input: MutationEnd | undefined): boolean {
  if (isRecord(input?.details)) {
    if (input.details.preview === true) {
      return false;
    }
    if (Array.isArray(input.details.modifiedFiles)) {
      return input.details.modifiedFiles.some(
        (file) => typeof file === "string" && file.trim().length > 0,
      );
    }
  }
  return input?.isError !== true && !["apply_patch", "replace_text", "write_files"].includes(tool);
}

export function createMutationCompletionTracker(): MutationCompletionTracker {
  const pending: PendingMutationTool[] = [];
  const take = (input?: MutationEnd): PendingMutationTool | undefined => {
    if (typeof input?.toolCallId === "string" && input.toolCallId !== "") {
      const index = pending.findIndex((tool) => tool.id === input.toolCallId);
      if (index >= 0) {
        return pending.splice(index, 1)[0];
      }
    }
    if (typeof input?.toolName === "string" && input.toolName !== "") {
      const index = pending.findIndex((tool) => tool.tool === input.toolName);
      if (index >= 0) {
        return pending.splice(index, 1)[0];
      }
    }
    return pending.shift();
  };
  return {
    recordToolStart(input) {
      const tool = input.toolName ?? "tool";
      const entry = {
        id: input.id,
        tool,
        path: input.path,
        mutates: input.mutates ?? isMutatingTool(input.toolName, input.args),
        startedAt: input.startedAt,
      };
      pending.push(entry);
      return entry;
    },
    recordToolResult(input) {
      const entry = take(input);
      if (!entry) {
        return;
      }
      const errored = input?.isError === true;
      return {
        ...entry,
        errored,
        completedMutation: entry.mutates && committedMutation(entry.tool, input),
      };
    },
  };
}

/** Owns the failure window and path streak; callers record events rather than mutate it. */
class MutatingFailures implements MutatingFailureState {
  private failures = 0;
  private lastAt: number | undefined;
  private readonly recent: FailedMutatingAttempt[] = [];
  private path: string | undefined;
  private repeated = 0;
  get consecutiveFailures(): number {
    return this.failures;
  }
  get lastFailureAt(): number | undefined {
    return this.lastAt;
  }
  get recentFailures(): readonly FailedMutatingAttempt[] {
    return this.recent;
  }
  get lastMutatingPath(): string | undefined {
    return this.path;
  }
  get repeatedPathFailures(): number {
    return this.repeated;
  }
  readonly reset = (): void => {
    this.failures = 0;
    this.lastAt = undefined;
    this.recent.length = 0;
    this.path = undefined;
    this.repeated = 0;
  };
  readonly record = (input: FailedMutatingAttempt, windowMs: number): void => {
    if (this.lastAt === undefined || input.ts - this.lastAt > windowMs) {
      this.reset();
    }
    this.lastAt = input.ts;
    this.failures += 1;
    if (input.path !== undefined && input.path !== "") {
      this.repeated = this.path === input.path ? this.repeated + 1 : 1;
      this.path = input.path;
    }
    this.recent.push(input);
    if (this.recent.length > 3) {
      this.recent.shift();
    }
  };
}

export function resetMutatingFailureState(state: MutatingFailureState): void {
  state.reset();
}

export function createMutatingFailureState(): MutatingFailureState {
  return new MutatingFailures();
}

export function recordMutatingFailure(
  state: MutatingFailureState,
  input: FailedMutatingAttempt,
  windowMs: number,
): void {
  state.record(input, windowMs);
}

export function shouldEscalateMutatingFailures(
  state: MutatingFailureState,
  threshold: number,
): boolean {
  return state.consecutiveFailures >= threshold || state.repeatedPathFailures >= threshold;
}

export function summarizeRecentMutatingFailures(state: MutatingFailureState): string | undefined {
  if (state.recentFailures.length === 0) {
    return undefined;
  }
  return state.recentFailures
    .map(
      (entry) =>
        `${entry.tool}${(entry.path ?? "") !== "" ? `(${entry.path ?? ""})` : ""}: ${entry.error}`,
    )
    .join(" | ");
}
