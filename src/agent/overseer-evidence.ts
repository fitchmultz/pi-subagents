import { isDeepStrictEqual } from "node:util";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { Escalation } from "./contracts.ts";

const CONSECUTIVE_ERROR_TURN_LIMIT = 3;
const LEGACY_TOOL_ERROR =
  /^Child hit (\d+) consecutive turns with tool\/command errors without clean progress\.$/u;

type ToolErrorTurns = NonNullable<Escalation["toolErrorTurns"]>;
interface ErrorTurn {
  readonly evidence: ToolErrorTurns[number];
  /** Only compared in memory. Never copied into evidence. */
  readonly failedCalls: readonly ToolCall[];
}

function errorTurn(event: TurnEndEvent, earlier: readonly ErrorTurn[]): ErrorTurn {
  const calls = new Map<string, ToolCall>();
  if (event.message.role === "assistant") {
    for (const item of event.message.content) {
      if (item.type === "toolCall" && item.argumentsError === undefined) {
        calls.set(item.id, item);
      }
    }
  }
  const failedCalls: ToolCall[] = [];
  const earlierCalls = earlier.flatMap((turn) => turn.failedCalls);
  const tools = event.toolResults.map(({ toolName, toolCallId, isError }) => {
    const result = { toolName, toolCallId, isError };
    const call = isError ? calls.get(toolCallId) : undefined;
    if (call?.name !== toolName) {
      return result;
    }
    failedCalls.push(call);
    const match = earlierCalls.find(
      (prior) =>
        prior.name === call.name &&
        prior.namespace === call.namespace &&
        isDeepStrictEqual(prior.arguments, call.arguments),
    );
    return match === undefined ? result : { ...result, repeatedFrom: match.id };
  });
  return { evidence: { messageEntryId: event.messageEntryId, tools }, failedCalls };
}

/** Keep the existing review cadence without treating any of these turns as stalled work. */
export class ToolErrorWindow {
  private readonly turns: ErrorTurn[] = [];

  clear(): void {
    this.turns.length = 0;
  }

  record(event: TurnEndEvent): ToolErrorTurns | undefined {
    if (!event.toolResults.some((result) => result.isError)) {
      this.clear();
      return undefined;
    }
    this.turns.push(errorTurn(event, this.turns));
    if (this.turns.length >= CONSECUTIVE_ERROR_TURN_LIMIT) {
      return this.turns.map((turn) => turn.evidence);
    }
    return undefined;
  }
}

export function escalationSteers(escalation: Escalation): number {
  return escalation.steers ?? escalation.corrections ?? 0;
}

export function escalationKindLabel(escalation: Escalation): string {
  if (escalation.classifierReview !== undefined) {
    return "review needed";
  }
  return escalation.toolErrorTurns !== undefined ||
    (escalation.kind === "loop_violation" && LEGACY_TOOL_ERROR.test(escalation.summary))
    ? "tool errors"
    : escalation.kind;
}

export function escalationEvidenceLines(escalation: Escalation): string[] {
  const { kind, summary, toolErrorTurns } = escalation;
  if (toolErrorTurns === undefined) {
    const legacyCount =
      kind === "loop_violation" ? LEGACY_TOOL_ERROR.exec(summary)?.[1] : undefined;
    return legacyCount === undefined
      ? [`Reason: ${summary}`]
      : [
          `Reason: ${legacyCount} consecutive turns reported tool errors.`,
          "This child did not publish tool outcomes for the pause.",
        ];
  }
  return [
    `Reason: ${summary}`,
    "Tool outcomes reported by Pi (turn entry and call IDs):",
    ...toolErrorTurns.map(({ messageEntryId, tools }) => {
      const outcomes = tools.map(({ toolName, toolCallId, isError, repeatedFrom }) => {
        const repeat =
          repeatedFrom === undefined ? "" : ` (same tool and arguments as ${repeatedFrom})`;
        return `${toolName} (${toolCallId}): ${isError ? "failed" : "succeeded"}${repeat}`;
      });
      return `  Turn ${messageEntryId}: ${outcomes.join("; ")}`;
    }),
  ];
}
