import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeAsyncControlRequest } from "../background/async-control.ts";
import {
  ownedRunExecutionResult,
  ownedRunProgressResult,
  ownedRunStatusResult,
} from "../shared/run-records.ts";
import {
  INTERCOM_DETACH_REQUEST_EVENT,
  INTERCOM_DETACH_RESPONSE_EVENT,
  POLL_INTERVAL_MS,
  type SubagentExecutionUpdateCallback,
  type OwnedRun,
  type SubagentExecutionResult,
} from "../../shared/types.ts";
import { errorMessage, isRecord } from "../../shared/unknown.ts";
import type { ExecutorDeps } from "./subagent-params.ts";
import { acquireRunWait } from "./wait-registration.ts";
import {
  observeWait,
  resolveWaitTarget,
  savedRunString,
  savedWaitResult,
  waitHasSavedResult,
  waitProducerAlive,
  type WaitObservation,
} from "./wait-observation.ts";

interface WaitInput {
  readonly id: string;
  readonly index?: number;
  readonly deps: Readonly<ExecutorDeps>;
  readonly ctx: ExtensionContext;
  readonly signal?: AbortSignal;
  readonly onUpdate?: SubagentExecutionUpdateCallback;
  readonly cancelNewRun?: boolean;
  readonly executionResult?: boolean;
  readonly includeProgress?: boolean;
}
type WaitStatus = "completed" | "cancelled" | "yielded" | "awaiting_input" | "unavailable";
interface WaitOutcome {
  readonly status: WaitStatus;
  readonly text: string;
  readonly result?: SubagentExecutionResult;
}

function unavailableWait(text: string): SubagentExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: "management", results: [] },
  };
}

/** Wait on the saved outcome, not the notification file or an early terminal status. */
export async function waitForOwnedRun(input: WaitInput): Promise<SubagentExecutionResult> {
  try {
    const owner = input.ctx.sessionManager.getSessionId();
    const session = input.deps.state.currentSessionId;
    const { run, nested } = resolveWaitTarget(input.id, input.deps);
    if (!run || (!nested && run.ownerSessionId !== owner)) {
      return unavailableWait(
        "Run is not available to wait on in this session. This wait did not start or stop work.",
      );
    }
    return await new RunWait(input, run, owner, session).start();
  } catch (error) {
    return unavailableWait(errorMessage(error));
  }
}

/** Own one foreground wait, its live timer, listener, cancellation and exactly-once release. */
class RunWait {
  private finished = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly pending = Promise.withResolvers<SubagentExecutionResult>();
  private previous = "";
  private readonly release: () => void;
  private readonly session: string | null;

  private readonly input: WaitInput;
  private readonly target: OwnedRun;
  private readonly owner: string;

  constructor(input: WaitInput, target: OwnedRun, owner: string, session: string | null) {
    this.input = input;
    this.target = target;
    this.owner = owner;
    this.session = session;
    this.release = acquireRunWait(input.deps.state, target.runId);
  }

  start(): Promise<SubagentExecutionResult> {
    try {
      this.unsubscribe = this.input.deps.pi.events.on(INTERCOM_DETACH_REQUEST_EVENT, this.detach);
      this.input.signal?.addEventListener("abort", this.abort, { once: true });
      if (this.input.signal?.aborted === true) {
        this.abort();
      } else {
        this.check();
      }
      // Unlike passive background tracking, this call owes a result. Keep the
      // process alive until finish() releases its timer; detached children cannot.
      if (!this.finished) {
        this.timer = setInterval(this.check, POLL_INTERVAL_MS);
      }
    } catch (error) {
      this.finish({ status: "unavailable", text: errorMessage(error) });
    }
    return this.pending.promise;
  }

  private finish(outcome: WaitOutcome): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.release();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    this.unsubscribe?.();
    this.input.signal?.removeEventListener("abort", this.abort);
    try {
      this.pending.resolve(this.result(outcome));
    } catch (error) {
      this.pending.resolve(
        this.result({
          status: "unavailable",
          text: `Wait could not read ${this.target.runId}: ${errorMessage(error)}`,
        }),
      );
    }
  }

  private result(outcome: WaitOutcome): SubagentExecutionResult {
    const { status, text, result } = outcome;
    const { index, deps, includeProgress } = this.input;
    const completed = status === "completed";
    const execution =
      this.input.executionResult === true && completed
        ? ownedRunExecutionResult(this.target, deps.state, index, includeProgress)
        : undefined;
    const completionId = completed
      ? savedRunString(this.target.runId, "result.json", "completionId")
      : undefined;
    return {
      ...result,
      ...execution,
      content: completed && execution ? execution.content : [{ type: "text", text }],
      ...(status === "unavailable" || status === "cancelled" ? { isError: true } : {}),
      details: {
        mode: "management",
        results: [],
        ...result?.details,
        ...execution?.details,
        wait: { runId: this.target.runId, completionId, index, status },
      },
    };
  }

  private readonly abort = (): void => {
    if (this.finished) {
      return;
    }
    try {
      if (
        this.input.cancelNewRun === true &&
        this.target.asyncDir !== undefined &&
        this.target.asyncDir.length > 0
      ) {
        writeAsyncControlRequest(this.target.asyncDir, this.target.runId, "cancel");
      }
    } catch (error) {
      this.finish({
        status: "cancelled",
        text: `Wait cancelled; cancellation request for newly launched run ${this.target.runId} could not be saved: ${errorMessage(error)}. Process exit is unconfirmed.`,
      });
      return;
    }
    this.finish({
      status: "cancelled",
      text:
        this.input.cancelNewRun === true
          ? `Wait cancelled; cancellation requested for newly launched run ${this.target.runId}. Process exit is not yet confirmed.`
          : `Stopped waiting for ${this.target.runId}. The child was not stopped; completion will arrive automatically.`,
    });
  };

  private readonly detach = (payload: unknown): void => {
    if (this.finished || !isRecord(payload) || typeof payload.requestId !== "string") {
      return;
    }
    this.input.deps.pi.events.emit(INTERCOM_DETACH_RESPONSE_EVENT, {
      requestId: payload.requestId,
      accepted: true,
    });
    this.finish({
      status: "yielded",
      text: `Released the wait for an incoming Intercom message. Run ${this.target.runId} is unchanged. Continue useful work or end the turn; completion will arrive automatically.`,
    });
  };

  private readonly check = (): void => {
    const { deps, ctx, index } = this.input;
    if (
      deps.state.currentSessionId !== this.session ||
      ctx.sessionManager.getSessionId() !== this.owner
    ) {
      this.finish({
        status: "unavailable",
        text: "The owning session changed. This wait ended without stopping the child.",
      });
      return;
    }
    try {
      const observation = observeWait(this.target, deps.state, this.owner, index);
      const outcome = this.observeOutcome(observation);
      if (outcome) {
        this.finish(outcome);
      } else {
        this.update(observation);
      }
    } catch (error) {
      this.finish({
        status: "unavailable",
        text: `Wait could not read ${this.target.runId}: ${errorMessage(error)}`,
      });
    }
  };

  private observeOutcome(observation: WaitObservation): WaitOutcome | undefined {
    const { deps, index } = this.input;
    const { children, questions } = observation;
    if (index !== undefined && children.length === 0) {
      return {
        status: "unavailable",
        text: `Run ${this.target.runId} has no child at index ${index}.`,
      };
    }
    if (questions.length > 0) {
      const result = ownedRunStatusResult(this.target, deps.state);
      return {
        status: "awaiting_input",
        text: `Run ${this.target.runId} needs input; waiting ended without stopping it.\n\n${questions.map((question) => `Question ${question.questionId}: ${question.message}`).join("\n\n")}`,
        result: { ...result, details: { ...result.details, questions } },
      };
    }
    if (waitHasSavedResult(observation, index)) {
      return {
        status: "completed",
        ...savedWaitResult(this.target, deps.state, observation, index),
      };
    }
    if (!waitProducerAlive(this.target, children)) {
      return {
        status: "unavailable",
        text: `No saved final result is available for ${this.target.runId}; completion is unconfirmed. Inspect the saved session. No work was started.`,
        result: ownedRunStatusResult(this.target, deps.state),
      };
    }
    return undefined;
  }

  private update(observation: WaitObservation): void {
    const { deps, index, onUpdate } = this.input;
    if (!onUpdate) {
      return;
    }
    const progress = ownedRunProgressResult(this.target, deps.state, index, observation.view);
    const signature = JSON.stringify(
      progress.details.progress?.map(({ durationMs: _duration, ...activity }) => activity),
    );
    if (signature === this.previous) {
      return;
    }
    this.previous = signature;
    const text = `Waiting for ${this.target.runId}${index !== undefined ? ` child ${index}` : ""}: ${observation.children.map((child) => child.state).join(", ")}. ${this.input.cancelNewRun === true ? "Cancelling requests cancellation of this newly launched run; process exit still needs confirmation." : "Cancelling this wait leaves existing work alive."}`;
    onUpdate({ ...progress, content: [{ type: "text", text }, ...progress.content] });
  }
}
