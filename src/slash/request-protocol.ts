import { Compile, Type } from "../shared/native-typebox.ts";
import { isRecord, isUnknownArray } from "../shared/unknown.ts";
import { resolveSlashMessageDetails } from "./slash-live-state.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";

const text = Type.Optional(Type.String());
const number = Type.Optional(Type.Number());
const progress = Compile(
  Type.Array(
    Type.Object(
      {
        index: Type.Number(),
        agent: Type.String(),
        task: Type.String(),
        status: Type.Enum(
          [
            "pending",
            "running",
            "completed",
            "complete",
            "failed",
            "blocked",
            "paused",
            "detached",
            "timed-out",
          ] as const,
          { type: "string" },
        ),
        model: text,
        thinking: text,
        modelStartedAt: number,
        activityState: Type.Optional(Type.Enum(["needs_attention"] as const, { type: "string" })),
        skills: Type.Optional(Type.Array(Type.String())),
        lastActivityAt: number,
        currentTool: text,
        currentToolArgs: text,
        currentToolStartedAt: number,
        currentPath: text,
        streamingText: text,
        recentTools: Type.Array(
          Type.Object(
            { tool: Type.String(), args: Type.String(), endMs: Type.Number() },
            { additionalProperties: true },
          ),
        ),
        recentOutput: Type.Array(Type.String()),
        toolCount: Type.Number(),
        turnCount: number,
        tokens: Type.Number(),
        durationMs: Type.Number(),
        error: text,
        failedTool: text,
      },
      { additionalProperties: true },
    ),
  ),
);

export function slashResponse(data: unknown, requestId: string): SlashSubagentResponse | undefined {
  if (!isRecord(data) || data.requestId !== requestId) {
    return undefined;
  }
  const details = resolveSlashMessageDetails({ requestId, result: data.result });
  if (!details || typeof data.isError !== "boolean") {
    throw new Error("Malformed slash subagent response.");
  }
  return {
    requestId,
    result: details.result,
    isError: data.isError,
    ...(typeof data.errorText === "string" ? { errorText: data.errorText } : {}),
  };
}

export function slashUpdate(data: unknown, requestId: string): SlashSubagentUpdate | undefined {
  if (!isRecord(data) || data.requestId !== requestId) {
    return undefined;
  }
  const rows: unknown = data.progress;
  const validated = isUnknownArray(rows) && progress.Check(rows) ? rows : undefined;
  return {
    requestId,
    ...(validated ? { progress: validated } : {}),
    ...(typeof data.currentTool === "string" ? { currentTool: data.currentTool } : {}),
    ...(typeof data.toolCount === "number" ? { toolCount: data.toolCount } : {}),
  };
}
