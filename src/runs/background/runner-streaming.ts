import * as fs from "node:fs";
import type { ReadonlyDeep } from "type-fest";
import { appendJsonl } from "../../shared/artifacts.ts";
import { readChildProcessIdentity } from "../../shared/post-exit-stdio-guard.ts";
import { extractToolArgsPreview } from "../../shared/utils.ts";
import {
  runChildAttempt,
  type ChildAttemptResult,
  type ChildEvent,
} from "../shared/child-attempt.ts";
import { FINALIZATION_EVENT } from "../shared/native-finalization.ts";
import { saveQuestionContract } from "../shared/supervisor-questions.ts";

interface ChildEventContext {
  readonly eventsPath: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly agent: string;
}

// Durable records omit repetitive progress deltas, but the live consumer sees every event.
const TRANSIENT_CHILD_EVENT_TYPES = new Set(["message_update", "tool_execution_update"]);

interface BoundaryMarker {
  readonly type: string;
  readonly nonce: string;
  readonly turn: number;
  readonly lastEntryId?: string;
  readonly messageCount: number;
  readonly at: number;
}

function hasBoundaryIdentity(
  value: object,
): value is Pick<BoundaryMarker, "type" | "nonce" | "lastEntryId"> {
  return (
    "type" in value &&
    value.type === FINALIZATION_EVENT &&
    "nonce" in value &&
    typeof value.nonce === "string" &&
    (!("lastEntryId" in value) || typeof value.lastEntryId === "string")
  );
}

function hasBoundaryCounters(
  value: object,
): value is Pick<BoundaryMarker, "turn" | "messageCount" | "at"> {
  return (
    "turn" in value &&
    typeof value.turn === "number" &&
    "messageCount" in value &&
    typeof value.messageCount === "number" &&
    "at" in value &&
    typeof value.at === "number"
  );
}

function isBoundaryMarker(value: unknown): value is BoundaryMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    hasBoundaryIdentity(value) &&
    hasBoundaryCounters(value)
  );
}

class ChildAudit {
  private readonly context: ChildEventContext;
  private readonly outputFile: string;

  constructor(context: ChildEventContext, outputFile: string) {
    this.context = context;
    this.outputFile = outputFile;
  }

  append(event: Readonly<object>): void {
    appendJsonl(
      this.context.eventsPath,
      JSON.stringify({
        ...event,
        recordVersion: 3,
        subagentSource: "child",
        subagentRunId: this.context.runId,
        subagentStepIndex: this.context.stepIndex,
        subagentAgent: this.context.agent,
        observedAt: Date.now(),
      }),
    );
  }

  record(event: ReadonlyDeep<ChildEvent>, result: ReadonlyDeep<ChildAttemptResult>): void {
    if (TRANSIENT_CHILD_EVENT_TYPES.has(event.type ?? "")) {
      return;
    }
    if (event.type === "subagent.native_baseline") {
      this.append(event);
      saveQuestionContract(this.context.runId, this.context.stepIndex, {
        attemptBaseline: result.attemptBaseline,
        baselineSource: "native-migration",
      });
      return;
    }
    if (event.type === "subagent.native") {
      this.append(event);
      saveQuestionContract(this.context.runId, this.context.stepIndex, {
        nativeSessionId: result.nativeSessionId,
        terminalLeafId: result.terminalLeafId,
        effectiveConfiguration: result.effectiveConfiguration,
        updatedAt: Date.now(),
      });
      return;
    }
    if (isBoundaryMarker(event)) {
      const file = `${this.outputFile}.boundaries.jsonl`;
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      this.append({
        type: event.type,
        nonce: event.nonce,
        turn: event.turn,
        lastEntryId: event.lastEntryId,
        messageCount: event.messageCount,
        at: event.at,
        boundaryFile: file,
      });
      return;
    }
    this.append({
      type: event.type,
      messageNumber: result.messageCount,
      ...(event.message ? { role: event.message.role, timestamp: event.message.timestamp } : {}),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      ...(event.type === "tool_execution_start"
        ? { argsPreview: extractToolArgsPreview(event.args ?? {}) }
        : {}),
      ...(event.type === "tool_execution_end" ? { auditPath: `${this.outputFile}.audit.log` } : {}),
    });
  }

  finalized(result: ReadonlyDeep<ChildAttemptResult>): void {
    this.append({
      type: "subagent.child.finalized",
      agentProcessExit: result.agentProcessExit,
      exitCode: result.exitCode,
      accounting: result.accounting,
      nativeSessionId: result.nativeSessionId,
      terminalLeafId: result.terminalLeafId,
      terminalEntryId: result.terminalEntryId,
      nativeReferences: result.nativeReferences,
      auditPath: result.auditPath,
      auditRecords: result.auditRecords,
      auditSaveError: result.auditSaveError,
      outputFile: this.outputFile,
    });
    saveQuestionContract(this.context.runId, this.context.stepIndex, {
      nativeSessionId: result.nativeSessionId,
      terminalLeafId: result.terminalLeafId,
      terminalEntryId: result.terminalEntryId,
      effectiveConfiguration: result.effectiveConfiguration,
      accounting: result.accounting,
      auditPath: result.auditPath,
      updatedAt: Date.now(),
    });
  }
}

export async function runPiStreaming(
  options: Parameters<typeof runChildAttempt>[0],
  outputFile: string,
  context: ChildEventContext,
): Promise<ChildAttemptResult> {
  const outputFd = fs.openSync(outputFile, "w", 0o600);
  const audit = new ChildAudit(context, outputFile);
  let outputWritten = false;
  try {
    const result = await runChildAttempt({
      ...options,
      auditPath: `${outputFile}.audit.log`,
      onStart: (control, started) => {
        if (control.pid !== undefined && control.pid !== 0) {
          saveQuestionContract(context.runId, context.stepIndex, {
            pid: control.pid,
            processIdentity: readChildProcessIdentity(control.pid),
            sessionFile: options.sessionFile,
            attemptBaseline: started.attemptBaseline,
            updatedAt: Date.now(),
          });
        }
        options.onStart?.(control, started);
      },
      onOutput: (text) => {
        fs.writeFileSync(outputFd, text);
        outputWritten ||= text.length > 0;
      },
      onStderr: (text) => {
        audit.append({
          type: "subagent.child.stderr",
          auditPath: `${outputFile}.audit.log`,
          length: Buffer.byteLength(text),
        });
      },
      onEvent: (event, observed, mutation) => {
        // Preserve callback ordering: disk publication follows the live owner update.
        options.onEvent?.(event, observed, mutation);
        audit.record(event, observed);
      },
    });
    // Native recovery and non-streaming providers can finalize text without publishing deltas.
    if (!outputWritten && result.finalOutput.length > 0) {
      fs.writeFileSync(outputFd, `${result.finalOutput}\n`);
    }
    audit.finalized(result);
    return result;
  } finally {
    fs.closeSync(outputFd);
  }
}
