import { spawn } from "node:child_process";
import { addAbortListener } from "node:events";
import {
  getSubagentDepthEnv,
  type ReadonlyInput,
  type ResourceLimitExceeded,
} from "../../shared/types.ts";
import { attachChildProcessLifecycle } from "../../shared/post-exit-stdio-guard.ts";
import { findLatestSessionFile, formatResourceLimitExceeded } from "../../shared/utils.ts";
import { resolveExecutionOutcome } from "./acceptance.ts";
import { snapshotNativeBaseline, type NativeBaseline } from "./native-usage.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { ChildObservationSpool } from "./child-observation-spool.ts";
import { ChildStreamObserver } from "./child-stream-observer.ts";
import { ChildEventObserver } from "./child-event-observer.ts";
import { accountNativeChild } from "./child-native-accounting.ts";
import { childExecutionOutcome } from "./child-execution-outcome.ts";
import { errorMessage as errorText } from "../../shared/unknown.ts";
import { nonempty } from "./child-presence.ts";
import type { ChildAttemptOptions, ChildAttemptResult } from "./child-attempt-types.ts";
export { buildChildInvocation } from "./child-invocation.ts";
export type {
  ChildEvent,
  ChildAttemptResult,
  ChildAttemptControl,
  NativeAttemptSegment,
} from "./child-attempt-types.ts";

type StopOutcome = Pick<ChildAttemptResult, "error" | "timedOut" | "interrupted">;
function initialResult(model?: string): ChildAttemptResult {
  return {
    stderr: "",
    exitCode: 0,
    messages: [],
    model,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    finalOutput: "",
    observedCompletedMutation: false,
    durationMs: 0,
  };
}
function nativeSessionFile(options: ReadonlyInput<ChildAttemptOptions>): string | undefined {
  if (options.claudeCodeInvocation) {
    return;
  }
  const index = options.args.indexOf("--session-dir");
  const directory = index >= 0 ? options.args.at(index + 1) : undefined;
  return (
    options.sessionFile ??
    (nonempty(directory) ? (findLatestSessionFile(directory) ?? undefined) : undefined)
  );
}

/** One process-group owner; event accounting, observation retention and native review are separate. */
class ChildAttemptRunner {
  private readonly options: ReadonlyInput<ChildAttemptOptions>;
  private readonly completion = Promise.withResolvers<ChildAttemptResult>();
  private readonly startedAt = Date.now();
  private readonly spool: ReadonlyInput<Pick<ChildObservationSpool, keyof ChildObservationSpool>>;
  private readonly events: ChildEventObserver;
  private readonly stream: ChildStreamObserver;
  private readonly lifecycle: ReturnType<typeof attachChildProcessLifecycle>;
  private resourceTimer?: NodeJS.Timeout;
  private abortListener?: Disposable;
  private interruptListener?: Disposable;
  private receiverFailed = false;
  private settled = false;
  private readonly pid?: number;

  constructor(
    options: ReadonlyInput<ChildAttemptOptions>,
    baseline: NativeBaseline,
    spool: ReadonlyInput<Pick<ChildObservationSpool, keyof ChildObservationSpool>>,
  ) {
    this.options = options;
    this.spool = spool;
    const command = options.claudeCodeInvocation ?? getPiSpawnCommand(options.args);
    const child = spawn(command.command, [...command.args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        ...getSubagentDepthEnv(options.maxSubagentDepth),
        PI_SUBAGENT_NATIVE_BASELINE_COUNT: baseline.legacy ? String(baseline.entryCount) : "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.pid = child.pid;
    this.lifecycle = attachChildProcessLifecycle(child);
    this.events = new ChildEventObserver(
      options,
      baseline,
      {
        observeLifecycle: (type) => this.lifecycle.observeEvent(type),
        stopping: () => this.lifecycle.stopping,
        stop: (outcome) => this.stop(outcome),
        resourceLimit: (kind, limit, observed) => this.resourceLimit(kind, limit, observed),
        resetTimer: () => this.resetResourceTimer(),
        reference: (entry) => this.stream.reference(entry),
      },
      this.startedAt,
    );
    this.stream = new ChildStreamObserver(this.spool, {
      claude: options.claudeCodeInvocation !== undefined,
      sessionFile: options.sessionFile,
      consume: (value, textWritten) => this.events.process(value, textWritten),
      output: options.onOutput,
      rawLine: options.onRawLine,
    });
    child.stdout.on("data", (bytes: Buffer) => this.receive(bytes));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => this.receiveStderr(text));
    child.on("close", (code, signal) => this.finish(code, signal));
    child.on("error", (error) => this.finish(1, undefined, error));
  }
  completed(): Promise<ChildAttemptResult> {
    return this.completion.promise;
  }

  start(): void {
    this.listenForCancellation();
    this.resetResourceTimer();
    const lifecycle = this.lifecycle;
    this.options.onStart?.(
      {
        pid: this.pid,
        get stopping() {
          return lifecycle.stopping;
        },
        stop: (outcome) => this.stop(outcome),
      },
      this.events.result,
    );
  }

  private stop(outcome: StopOutcome): void {
    if (this.settled) {
      return;
    }
    Object.assign(this.events.result, outcome);
    this.events.result.durationMs = Date.now() - this.startedAt;
    if (nonempty(outcome.error)) {
      this.options.onOutput?.(`${outcome.error}\n`);
    }
    this.options.onFailure?.(this.events.result);
    this.lifecycle.terminate();
  }
  private resourceLimit(
    kind: ResourceLimitExceeded["kind"],
    limit: number,
    observed?: number,
  ): void {
    const result = this.events.result;
    if (
      this.settled ||
      result.resourceLimitExceeded ||
      result.timedOut === true ||
      this.lifecycle.stopping
    ) {
      return;
    }
    const message = formatResourceLimitExceeded({
      agent: this.options.agent,
      kind,
      limit,
      observed,
    });
    result.resourceLimitExceeded = {
      kind,
      limit,
      ...(observed !== undefined ? { observed } : {}),
      message,
    };
    this.stop({ error: message });
  }
  private resetResourceTimer(): void {
    clearTimeout(this.resourceTimer);
    const limit = this.options.maxExecutionTimeMs;
    if (limit === undefined) {
      return;
    }
    this.resourceTimer = setTimeout(
      () => {
        this.events.sync();
        if (Date.now() - this.events.boundaries.startedAt >= limit) {
          this.resourceLimit("maxExecutionTimeMs", limit);
        } else {
          this.resetResourceTimer();
        }
      },
      Math.max(0, limit - (Date.now() - this.events.boundaries.startedAt)),
    );
    this.resourceTimer.unref();
  }
  private listenForCancellation(): void {
    const { signal, interruptSignal } = this.options;
    if (signal) {
      this.abortListener = addAbortListener(signal, () => {
        const reason: unknown = signal.reason;
        const timedOut = reason instanceof Error && reason.name === "TimeoutError";
        this.stop({
          error: timedOut ? reason.message : "Subagent cancelled.",
          timedOut: timedOut || undefined,
          interrupted: false,
        });
      });
    }
    if (interruptSignal) {
      this.interruptListener = addAbortListener(interruptSignal, () => {
        if (
          signal?.aborted === true ||
          this.events.result.resourceLimitExceeded ||
          this.events.result.timedOut === true
        ) {
          return;
        }
        this.stop({ interrupted: true, error: undefined });
      });
    }
  }
  private receive(bytes: Buffer): void {
    try {
      if (this.receiverFailed) {
        this.stream.saveUnparsed(bytes);
      } else {
        this.stream.write(bytes);
      }
    } catch (error) {
      this.receiverFailed = true;
      this.events.result.terminalFailure = true;
      this.stop({ error: `Cannot receive child events: ${errorText(error)}` });
    }
  }
  private receiveStderr(text: string): void {
    try {
      this.spool.writeStderr(text);
      this.events.result.stderr = (this.events.result.stderr + text).slice(-16384);
      this.options.onStderr?.(text);
    } catch (error) {
      this.events.result.terminalFailure = true;
      this.stop({ error: `Cannot save child diagnostics: ${errorText(error)}` });
    }
  }
  private drainObservations(): void {
    try {
      if (!this.receiverFailed) {
        this.stream.finish();
      }
    } catch (error) {
      this.receiverFailed = true;
      this.events.result.error ??= errorText(error);
      this.events.result.terminalFailure = true;
    }
    try {
      this.events.sync();
    } catch (error) {
      this.events.result.error ??= `Cannot read finalization boundary: ${errorText(error)}`;
      this.events.result.terminalFailure = true;
    }
  }
  private finish(
    code: number | null,
    signal?: NodeJS.Signals | null,
    spawnError?: Readonly<Error>,
  ): void {
    if (this.settled) {
      return;
    }
    this.drainObservations();
    this.settled = true;
    clearTimeout(this.resourceTimer);
    this.abortListener?.[Symbol.dispose]();
    this.interruptListener?.[Symbol.dispose]();
    const result = this.events.result;
    result.agentProcessExit = this.lifecycle.agentProcessExit;
    result.durationMs = Date.now() - this.startedAt;
    Object.assign(
      result,
      childExecutionOutcome({
        result,
        options: this.options,
        code,
        signal,
        spawnError,
        stopping: this.lifecycle.stopping,
        settledCleanup: this.lifecycle.settledCleanup,
        cleanAssistantStop: this.events.cleanAssistantStop,
        assistantError: this.events.assistantError,
      }),
    );
    result.finalOutput =
      result.resourceLimitExceeded?.message ??
      (this.events.lastOutput.length > 0 ? this.events.lastOutput : this.stream.rawOutput.trim());
    const boundary = this.events.boundaries.finish(result);
    result.finalization = boundary.finalization;
    if (boundary.missing) {
      result.error = "Native self-review boundary did not return a result.";
      result.exitCode = 1;
      result.terminalFailure = true;
    }
    this.finalizeAccounting();
    this.completion.resolve(result);
  }
  private finalizeAccounting(): void {
    const result = this.events.result;
    const native = accountNativeChild({
      file: nativeSessionFile(this.options),
      result,
      baseline: this.events.baseline,
      acceptedEntries: this.events.acceptedEntries,
      reference: (entry) => this.stream.reference(entry),
      observations: () => this.stream.observed(),
    });
    result.accounting = native.accounting;
    result.nativeSessionId = native.nativeSessionId;
    result.terminalEntryId = native.terminalEntryId;
    result.terminalLeafId = native.terminalLeafId;
    result.effectiveConfiguration = native.effectiveConfiguration;
    if (native.usage) {
      result.usage = native.usage;
    }
    for (const [index, segment] of (result.finalization ?? []).entries()) {
      const usage = native.segmentUsage?.at(index);
      if (usage) {
        segment.usage = usage;
      }
    }
    const retained = this.stream.published(native.publishedIds);
    for (const item of retained) {
      if (nonempty(item.nativeEntryId)) {
        (result.nativeReferences ??= []).push({
          messageNumber: item.number,
          entryId: item.nativeEntryId,
        });
      }
    }
    const audit = this.spool.retain(retained, this.receiverFailed);
    result.auditPath = audit.auditPath;
    result.auditSaveError = audit.auditSaveError;
    result.auditRecords = audit.auditRecords?.slice();
  }
}

/** One owned process group and finalized JSON event stream for either native backend. */
export async function runChildAttempt(
  options: ReadonlyInput<ChildAttemptOptions>,
): Promise<ChildAttemptResult> {
  const result = initialResult(options.model);
  if (options.signal?.aborted === true || options.interruptSignal?.aborted === true) {
    Object.assign(
      result,
      resolveExecutionOutcome({
        result,
        signal: options.signal,
        interruptSignal: options.interruptSignal,
      }),
    );
    result.finalOutput = result.error ?? "Interrupted. Waiting for explicit next action.";
    return result;
  }
  let baseline: NativeBaseline;
  try {
    baseline = snapshotNativeBaseline(nativeSessionFile(options));
  } catch (error) {
    return {
      ...result,
      exitCode: 1,
      terminalFailure: true,
      error: `Cannot capture native usage baseline: ${errorText(error)}`,
    };
  }
  let spool: ChildObservationSpool;
  try {
    spool = new ChildObservationSpool(options.auditPath);
  } catch (error) {
    return {
      ...result,
      exitCode: 1,
      terminalFailure: true,
      error: `Cannot prepare child observations: ${errorText(error)}`,
    };
  }
  const runner = new ChildAttemptRunner(options, baseline, spool);
  runner.start();
  return runner.completed();
}
