import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  RESULTS_DIR,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type SubagentState,
  type OwnedRun,
} from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { finalizedChildUsage, type registerParentUsage } from "../shared/parent-usage.ts";
import { ownedRunView, rememberOwnedRun, repairOwnedRunAccounting } from "../shared/run-records.ts";
import registerSubagentNotify from "./notify.ts";
import { createResultWatcher } from "./result-watcher.ts";
import { CompletionReceipts } from "./completion-receipts.ts";
import { errorMessage, hasText, isRecord, stringField } from "./async-value.ts";

type ParentUsageRecorder = Readonly<Pick<ReturnType<typeof registerParentUsage>, "isRecorded">>;
interface Admission {
  readonly sessionId: string | null;
  pending: boolean;
  readonly channel: "notification" | "intercom";
}
interface CompletionDeliveryHandle {
  readonly start: () => void;
  readonly stop: () => void;
  readonly stopAndJoin: (options?: { readonly preservePending?: boolean }) => Promise<void>;
}
function isAdmissions(value: unknown): value is Map<string, Admission> {
  if (!(value instanceof Map)) {
    return false;
  }
  const entries: Map<unknown, unknown> = value;
  return [...entries].every(
    ([key, admission]) =>
      typeof key === "string" &&
      isRecord(admission) &&
      (admission.sessionId === null || typeof admission.sessionId === "string") &&
      typeof admission.pending === "boolean" &&
      (admission.channel === "notification" || admission.channel === "intercom"),
  );
}
function admissions(): Map<string, Admission> {
  const store = globalThis as Record<string, unknown>;
  const key = "__pi_subagents_queued_notifications__";
  const existing = store[key];
  const queued = isAdmissions(existing) ? existing : new Map<string, Admission>();
  store[key] = queued;
  return queued;
}

/** Completion authority is the published parent receipt, never queue/send acceptance. */
class CompletionDelivery {
  private readonly pi: ReadonlyInput<ExtensionAPI>;
  private readonly state: SubagentState;
  private readonly parentUsage: ParentUsageRecorder;
  private readonly queued = admissions();
  private readonly receipts: CompletionReceipts;
  private readonly watcher: ReturnType<typeof createResultWatcher>;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeNotify: (() => void) | undefined;

  constructor(
    pi: ReadonlyInput<ExtensionAPI>,
    state: SubagentState,
    parentUsage: ParentUsageRecorder,
  ) {
    this.pi = pi;
    this.state = state;
    this.parentUsage = parentUsage;
    this.receipts = new CompletionReceipts(state);
    pi.on("turn_end", (event, ctx) => {
      this.settleAdmissions(event.context.pendingMessages.length > 0, ctx);
    });
    this.state.isRunResultConsumed = (runId) => this.receipts.consumed(runId) !== undefined;
    this.watcher = createResultWatcher(pi, state, RESULTS_DIR, {
      reconcileDelivery: this.reconcileDelivery,
      withReceiptBatch: this.receipts.batch,
      isCompletionPublished: (runId, key) =>
        this.receipts.publishedReceipt(runId, key) !== undefined,
    });
  }

  private settleAdmissions(pending: boolean, ctx: ExtensionContext): void {
    // ponytail: this is the next batch, not the whole queue. Full selective removal
    // requires a public full-queue snapshot; ambiguous admissions remain until publication/empty queues.
    for (const [key, admission] of this.queued) {
      if (
        admission.channel !== "notification" ||
        admission.sessionId !== ctx.sessionManager.getSessionId()
      ) {
        continue;
      }
      admission.pending = pending;
      if (!pending) {
        this.queued.delete(key);
        this.state.completionSeen.delete(key);
      }
    }
  }

  private accountingProjection(
    children: ReadonlyInput<ReturnType<typeof ownedRunView>["children"]>,
    ctx: ExtensionContext,
  ): { readonly state: "incomplete" | "complete" | "pending"; readonly error?: string } {
    const incomplete = children.find((child) => child.result?.accounting?.state === "incomplete");
    if (incomplete) {
      return { state: "incomplete", error: incomplete.result?.accounting?.error };
    }
    return {
      state: this.parentUsage.isRecorded(
        finalizedChildUsage(children),
        ctx,
        this.receipts.read().saved,
      )
        ? "complete"
        : "pending",
    };
  }

  private recordAccounting(runId: string): void {
    const run = this.state.ownedRuns?.get(runId);
    const ctx = this.state.lastUiContext;
    if (!run || !ctx) {
      return;
    }
    try {
      repairOwnedRunAccounting(run);
      const children = ownedRunView(run, this.state, { readConfiguration: false }).children;
      const accounting = this.accountingProjection(children, ctx);
      rememberOwnedRun(this.state, { ...(this.state.ownedRuns?.get(runId) ?? run), accounting });
    } catch (error) {
      try {
        rememberOwnedRun(this.state, {
          ...(this.state.ownedRuns?.get(runId) ?? run),
          accounting: { state: "incomplete", error: errorMessage(error) },
        });
      } catch (saveError) {
        console.error(`Could not save accounting projection for ${runId}:`, saveError);
      }
      console.error(`Subagent ${runId} accounting remains incomplete:`, error);
    }
  }

  private recordPublished(
    runId: string,
    key: string,
    receipt: SessionEntry,
    accounting: boolean,
  ): void {
    this.queued.delete(key);
    this.state.completionSeen.delete(key);
    // Save delivery before accounting. Failed owner append cannot make a published identity eligible again.
    try {
      const run = this.state.ownedRuns?.get(runId);
      if (run) {
        rememberOwnedRun(this.state, {
          ...run,
          completion: { id: key, state: "journaled", entryId: receipt.id },
          delivery: {
            notifiedAt: Date.parse(receipt.timestamp),
            intercomDelivered:
              receipt.type === "custom_message" && receipt.customType === "intercom_message",
            completionId: key,
            entryId: receipt.id,
          },
        });
      }
    } catch (error) {
      console.error(`Could not save delivery projection for ${runId}:`, error);
    }
    if (accounting) {
      this.recordAccounting(runId);
    }
  }

  private hasAdmission(runId: string, key: string): boolean {
    const completion = this.state.ownedRuns?.get(runId)?.completion;
    return this.queued.has(key) || (completion?.id === key && completion.state === "queued");
  }
  private pendingQueue(ctx: ExtensionContext | null | undefined, key: string): boolean {
    return (
      !ctx || this.queued.get(key)?.pending === true || !ctx.isIdle() || ctx.hasPendingMessages()
    );
  }

  private queuedDelivery(runId: string, key: string): boolean {
    const ctx = this.state.lastUiContext;
    const run = this.state.ownedRuns?.get(runId);
    if (!this.hasAdmission(runId, key)) {
      return false;
    }
    // The durable Intercom inbox owns restart reconciliation; remote acknowledgement exposes no parent commit boundary.
    if (run?.completion?.channel === "intercom") {
      return true;
    }
    if (this.pendingQueue(ctx, key)) {
      return true;
    }
    this.queued.delete(key);
    this.state.completionSeen.delete(key);
    if (run) {
      rememberOwnedRun(this.state, { ...run, completion: { id: key, state: "dropped" } });
    }
    return false;
  }

  private readonly reconcileDelivery = (runId: string, key: string, accounting = true): boolean => {
    const index = this.receipts.read();
    const receipt = this.receipts.publishedReceipt(runId, key, index);
    if (receipt) {
      this.recordPublished(runId, key, receipt, accounting);
      return true;
    }
    if (!this.state.lastUiContext) {
      return true;
    }
    // Accepted-but-unflushed receipts and native pending queues are ambiguous, not duplicate admissions.
    if (this.receipts.hasUnpublished(runId, key, index.saved)) {
      this.queued.delete(key);
      this.state.completionSeen.delete(key);
      return true;
    }
    return this.queuedDelivery(runId, key);
  };

  private markQueued(
    runId: string,
    key: string,
    channel: Admission["channel"] = "notification",
  ): void {
    this.queued.set(key, { sessionId: this.state.currentSessionId, pending: false, channel });
    const run = this.state.ownedRuns?.get(runId);
    if (run) {
      rememberOwnedRun(this.state, {
        ...run,
        completion: { id: key, state: "queued", channel, queuedAt: Date.now() },
      });
    }
  }

  private completionRun(
    data: Readonly<Record<string, unknown>>,
  ): ReadonlyInput<OwnedRun> | undefined {
    const runId = stringField(data, "runId") ?? stringField(data, "id") ?? "";
    const run = this.state.ownedRuns?.get(runId);
    if (
      !run ||
      (data.sessionId !== this.state.currentSessionId &&
        run.ownerSessionId !== this.state.currentSessionId)
    ) {
      return undefined;
    }
    return run;
  }

  private completed(data: unknown): void {
    if (!isRecord(data)) {
      return;
    }
    const run = this.completionRun(data);
    if (!run) {
      return;
    }
    if (typeof data.completionKey === "string" && data.completionKey.length > 0) {
      if (data.intercomResultDelivered === true) {
        this.markQueued(run.runId, data.completionKey, "intercom");
      }
      this.reconcileDelivery(run.runId, data.completionKey);
    }
    if (data.suppressNotification === true) {
      this.recordAccounting(run.runId);
    }
  }

  start = (): void => {
    if (!this.unsubscribe) {
      this.unsubscribeNotify = registerSubagentNotify(this.pi, (key, runId) => {
        if (hasText(runId)) {
          this.markQueued(runId, key);
        }
      });
      this.unsubscribe = this.pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
        this.completed(data);
      });
    }
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    this.watcher.startResultWatcher();
    this.watcher.primeExistingResults();
  };
  private stopListening(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeNotify?.();
    this.unsubscribeNotify = undefined;
    this.receipts.clear();
  }
  stop = (): void => {
    this.watcher.stopResultWatcher();
    this.stopListening();
  };
  stopAndJoin = async (options: { readonly preservePending?: boolean } = {}): Promise<void> => {
    // Accepted deliveries settle while the old owner and listeners remain valid.
    this.watcher.stopResultWatcher({ ...options, joinInFlight: true });
    await this.watcher.joinInFlight();
    this.stopListening();
  };
}

export function createCompletionDelivery(
  pi: ReadonlyInput<ExtensionAPI>,
  state: SubagentState,
  parentUsage: ParentUsageRecorder,
): CompletionDeliveryHandle {
  const delivery = new CompletionDelivery(pi, state, parentUsage);
  return { start: delivery.start, stop: delivery.stop, stopAndJoin: delivery.stopAndJoin };
}
