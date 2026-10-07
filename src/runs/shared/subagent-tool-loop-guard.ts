import { createHash } from "node:crypto";
import { stableStringify } from "./stable-value.ts";
import { isRecord } from "../../shared/unknown.ts";

const REPEATED_SUBAGENT_CALL_LIMIT = 5;
const SUBAGENT_CALL_WINDOW_SIZE = REPEATED_SUBAGENT_CALL_LIMIT * 2 - 1;

interface SubagentCallStart {
  readonly callKey: string;
  readonly toolName: unknown;
  readonly failed?: boolean;
  readonly toolCallId?: string;
}

interface ToolStart {
  readonly toolCallId?: unknown;
  readonly toolName: unknown;
  readonly args: unknown;
}
interface ToolEnd {
  readonly toolCallId?: unknown;
  readonly toolName: unknown;
  readonly isError: unknown;
}
export interface RepeatedSubagentCallGuardState {
  readonly recentStarts: readonly boolean[];
  readonly recentSubagentCalls: readonly SubagentCallStart[];
  readonly recordStart: (input: ToolStart) => string | undefined;
  readonly recordEnd: (input: ToolEnd) => string | undefined;
}

function subagentCallKey(toolName: unknown, args: unknown): string | undefined {
  if (
    (toolName !== "subagent" && toolName !== "delegate" && toolName !== "agent_runs") ||
    !isRecord(args)
  ) {
    return;
  }
  try {
    return createHash("sha256")
      .update(`${toolName}:${stableStringify(args)}`)
      .digest("hex");
  } catch {
    return;
  }
}

/** The guard owns its bounded windows; callers only observe snapshots and record events. */
class RepeatedCalls implements RepeatedSubagentCallGuardState {
  private readonly starts: boolean[] = [];
  private readonly calls: SubagentCallStart[] = [];
  get recentStarts(): readonly boolean[] {
    return this.starts;
  }
  get recentSubagentCalls(): readonly SubagentCallStart[] {
    return this.calls;
  }

  readonly recordStart = (input: ToolStart): string | undefined => {
    const args = input.args;
    const listAction =
      isRecord(args) &&
      ((input.toolName === "subagent" && args.action === "list") ||
        (input.toolName === "agent_runs" && args.action === "profiles"));
    this.starts.push(listAction);
    if (this.starts.length > SUBAGENT_CALL_WINDOW_SIZE) {
      this.starts.shift();
    }
    this.recordCall(input);
    const count = this.starts.filter(Boolean).length;
    if (listAction && count >= REPEATED_SUBAGENT_CALL_LIMIT) {
      const tool = input.toolName === "subagent" ? "subagent" : "agent_runs";
      const action = tool === "subagent" ? "list" : "profiles";
      return `Child appears stuck repeating ${tool}({ action: "${action}" }) ${count} times. Stopping to avoid a tool loop.`;
    }
    return;
  };

  private recordCall(input: ToolStart): void {
    const callKey = subagentCallKey(input.toolName, input.args);
    if (callKey !== undefined) {
      this.calls.push({
        callKey,
        toolName: input.toolName,
        toolCallId: typeof input.toolCallId === "string" ? input.toolCallId : undefined,
      });
      if (this.calls.length > SUBAGENT_CALL_WINDOW_SIZE) {
        this.calls.shift();
      }
    }
  }

  readonly recordEnd = (input: ToolEnd): string | undefined => {
    if (input.isError !== true) {
      return;
    }
    const toolCallId = typeof input.toolCallId === "string" ? input.toolCallId : undefined;
    const index = this.calls.findLastIndex(
      (candidate) =>
        candidate.toolName === input.toolName &&
        candidate.failed === undefined &&
        ((toolCallId ?? "") === "" ||
          (candidate.toolCallId ?? "") === "" ||
          candidate.toolCallId === toolCallId),
    );
    if (index < 0) {
      return;
    }
    const entry = this.calls.at(index);
    if (!entry) {
      return;
    }
    this.calls[index] = { ...entry, failed: true };
    const count = this.calls.filter(
      (candidate) => candidate.failed === true && candidate.callKey === entry.callKey,
    ).length;
    if (count >= REPEATED_SUBAGENT_CALL_LIMIT) {
      const tool = typeof input.toolName === "string" ? input.toolName : "tool";
      return `Child appears stuck repeating the same failed ${tool} call ${count} times. Stopping to avoid a tool loop.`;
    }
    return;
  };
}

export function createRepeatedSubagentCallGuardState(): RepeatedSubagentCallGuardState {
  return new RepeatedCalls();
}

export function recordToolStartForSubagentLoopGuard(
  input: ToolStart & { readonly state: RepeatedSubagentCallGuardState },
): string | undefined {
  return input.state.recordStart(input);
}

export function recordToolEndForSubagentLoopGuard(
  input: ToolEnd & { readonly state: RepeatedSubagentCallGuardState },
): string | undefined {
  return input.state.recordEnd(input);
}
