import type {
  ExtensionContext,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { SessionEntryCursor } from "../../shared/session-entries.ts";
import { createParentReceiptReader } from "../shared/parent-receipts.ts";
import type { SubagentState, OwnedRun } from "../../shared/types.ts";
import type { ReadonlyInput } from "../../shared/types/inputs.ts";
import { hasText, isRecord, stringField } from "./async-value.ts";

type ReceiptEntry = SessionEntry;
type SavedReceipts = Readonly<ReadonlyMap<string, ReceiptEntry>>;
interface ReceiptState {
  readonly lastUiContext: SubagentState["lastUiContext"];
  readonly currentSessionId: SubagentState["currentSessionId"];
  readonly ownedRuns?: Readonly<ReadonlyMap<string, Readonly<Pick<OwnedRun, "mode">>>>;
}
interface WaitReceipt {
  readonly runId: string;
  readonly index?: number;
}
interface CompletionReceipt {
  readonly runId: string;
  readonly key?: string;
  readonly completionId?: string;
  readonly ownerSessionId?: string;
}
interface ReceiptIdentity {
  readonly wait?: WaitReceipt;
  readonly completion?: CompletionReceipt;
}
interface ReceiptIndex {
  readonly saved: SavedReceipts;
  readonly completed: SavedReceipts;
  readonly singles: SavedReceipts;
  readonly completions: SavedReceipts;
  readonly legacy: SavedReceipts;
}
interface ReceiptSnapshotKey {
  readonly manager: ExtensionContext["sessionManager"] | undefined;
  readonly file: string | undefined;
  readonly leaf: string | null | undefined;
  readonly count: number | undefined;
}
interface ReceiptSnapshot extends ReceiptSnapshotKey {
  readonly index: ReceiptIndex;
}

function entryDetails(entry: ReceiptEntry): unknown {
  if (entry.type === "message" && entry.message.role === "toolResult") {
    return entry.message.details;
  }
  return entry.type === "custom_message" ? entry.details : undefined;
}
function waitIdentity(value: unknown): WaitReceipt | undefined {
  if (
    !isRecord(value) ||
    value.status !== "completed" ||
    typeof value.runId !== "string" ||
    (value.index !== undefined && typeof value.index !== "number")
  ) {
    return undefined;
  }
  return { runId: value.runId, index: value.index };
}
function completionIdentity(value: unknown): CompletionReceipt | undefined {
  if (!isRecord(value) || typeof value.runId !== "string") {
    return undefined;
  }
  if (
    !["key", "completionId", "ownerSessionId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    )
  ) {
    return undefined;
  }
  return {
    runId: value.runId,
    key: stringField(value, "key"),
    completionId: stringField(value, "completionId"),
    ownerSessionId: stringField(value, "ownerSessionId"),
  };
}
function identity(entry: ReceiptEntry): ReceiptIdentity {
  const details = entryDetails(entry);
  if (!isRecord(details)) {
    return {};
  }
  let wait: unknown;
  if (entry.type === "message") {
    wait = details.wait;
  } else if (isRecord(details.result) && isRecord(details.result.details)) {
    wait = details.result.details.wait;
  }
  return {
    wait: waitIdentity(wait),
    completion: completionIdentity(details.completion ?? details.subagentCompletion),
  };
}
function legacyOwner(completion: CompletionReceipt, ownerSessionId: string | null): boolean {
  return (
    !hasText(completion.completionId) &&
    (completion.ownerSessionId === undefined || completion.ownerSessionId === ownerSessionId)
  );
}

class ReceiptIndexBuilder {
  private readonly completed = new Map<string, ReceiptEntry>();
  private readonly singles = new Map<string, ReceiptEntry>();
  private readonly completions = new Map<string, ReceiptEntry>();
  private readonly legacy = new Map<string, ReceiptEntry>();

  private addWait(wait: WaitReceipt, entry: ReceiptEntry): void {
    let target;
    if (wait.index === undefined) {
      target = this.completed;
    }
    if (wait.index === 0) {
      target = this.singles;
    }
    if (target && !target.has(wait.runId)) {
      target.set(wait.runId, entry);
    }
  }
  private addCompletion(
    completion: CompletionReceipt,
    entry: ReceiptEntry,
    ownerSessionId: string | null,
  ): void {
    const keys = [
      completion.key,
      hasText(completion.completionId) ? `completion:${completion.completionId}` : undefined,
    ];
    for (const key of keys) {
      if (hasText(key) && !this.completions.has(`${completion.runId}\0${key}`)) {
        this.completions.set(`${completion.runId}\0${key}`, entry);
      }
    }
    if (legacyOwner(completion, ownerSessionId) && !this.legacy.has(completion.runId)) {
      this.legacy.set(completion.runId, entry);
    }
  }
  add(entry: ReceiptEntry, ownerSessionId: string | null): void {
    const data = identity(entry);
    if (data.wait) {
      this.addWait(data.wait, entry);
    }
    if (entry.type === "custom_message" && data.completion && data.completion.runId.length > 0) {
      this.addCompletion(data.completion, entry, ownerSessionId);
    }
  }
  snapshot(saved: SavedReceipts): ReceiptIndex {
    return {
      saved,
      completed: this.completed,
      singles: this.singles,
      completions: this.completions,
      legacy: this.legacy,
    };
  }
}
function indexReceipts(saved: SavedReceipts, ownerSessionId: string | null): ReceiptIndex {
  const builder = new ReceiptIndexBuilder();
  for (const entry of saved.values()) {
    builder.add(entry, ownerSessionId);
  }
  return builder.snapshot(saved);
}
function snapshotKey(manager: ExtensionContext["sessionManager"] | undefined): ReceiptSnapshotKey {
  const withCount: Partial<SessionManager> | undefined = manager;
  return {
    manager,
    file: manager?.getSessionFile(),
    leaf: manager?.getLeafId(),
    count: withCount?.getEntryCount?.(),
  };
}
function sameSnapshot(
  saved: ReadonlyInput<ReceiptSnapshot>,
  current: ReadonlyInput<ReceiptSnapshotKey>,
): boolean {
  return (
    current.count !== undefined &&
    saved.manager === current.manager &&
    saved.file === current.file &&
    saved.leaf === current.leaf &&
    saved.count === current.count
  );
}

/** Publication proof and in-memory candidate tracking are scoped to one parent session. */
export class CompletionReceipts {
  private readonly state: ReceiptState;
  private readonly published = createParentReceiptReader("live");
  private readonly completedCursor = new SessionEntryCursor();
  private readonly entryIds = new Set<string>();
  private batching = false;
  private snapshot: ReceiptSnapshot | undefined;
  constructor(state: ReceiptState) {
    this.state = state;
  }

  read(): ReceiptIndex {
    const current = snapshotKey(this.state.lastUiContext?.sessionManager);
    if (this.batching && this.snapshot && sameSnapshot(this.snapshot, current)) {
      return this.snapshot.index;
    }
    const index = indexReceipts(this.published.read(current.file), this.state.currentSessionId);
    if (this.batching) {
      this.snapshot = { ...current, index };
    }
    return index;
  }
  batch = (work: () => void): void => {
    // Only this synchronous stack shares proof. Parent count/leaf changes invalidate it.
    this.batching = true;
    this.snapshot = undefined;
    try {
      work();
    } finally {
      this.batching = false;
      this.snapshot = undefined;
    }
  };
  consumed(runId: string, index = this.read()): ReceiptEntry | undefined {
    return (
      index.completed.get(runId) ??
      (this.state.ownedRuns?.get(runId)?.mode === "single" ? index.singles.get(runId) : undefined)
    );
  }
  publishedReceipt(runId: string, key: string, index = this.read()): ReceiptEntry | undefined {
    return (
      this.consumed(runId, index) ??
      index.completions.get(`${runId}\0${key}`) ??
      (key.startsWith("completion:legacy:") ? index.legacy.get(runId) : undefined)
    );
  }
  private consumedIdentity(wait: WaitReceipt | undefined, runId: string): boolean {
    return (
      wait?.runId === runId &&
      (wait.index === undefined ||
        (this.state.ownedRuns?.get(runId)?.mode === "single" && wait.index === 0))
    );
  }
  private completionMatches(completion: CompletionReceipt, key: string): boolean {
    return (
      completion.key === key ||
      (hasText(completion.completionId) && `completion:${completion.completionId}` === key) ||
      (key.startsWith("completion:legacy:") && legacyOwner(completion, this.state.currentSessionId))
    );
  }
  private matches(entry: ReceiptEntry, runId: string, key: string): boolean {
    const data = identity(entry);
    if (this.consumedIdentity(data.wait, runId)) {
      return true;
    }
    if (entry.type !== "custom_message" || data.completion?.runId !== runId) {
      return false;
    }
    return this.completionMatches(data.completion, key);
  }
  private readParentChanges(): void {
    const ctx = this.state.lastUiContext;
    if (!ctx) {
      return;
    }
    const changes = this.completedCursor.read(ctx.sessionManager);
    if (changes.reset) {
      this.entryIds.clear();
    }
    for (const entry of changes.entries) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (["subagent", "delegate", "agent_runs"].includes(entry.message.toolName)) {
          this.entryIds.add(entry.id);
        }
      } else if (
        entry.type === "custom_message" &&
        ["subagent-notify", "intercom_message", "subagent-slash-result"].includes(entry.customType)
      ) {
        this.entryIds.add(entry.id);
      }
    }
  }
  hasUnpublished(runId: string, key: string, saved: SavedReceipts): boolean {
    const ctx = this.state.lastUiContext;
    if (!ctx) {
      return false;
    }
    this.readParentChanges();
    return [...this.entryIds].some((id) => {
      if (saved.has(id)) {
        return false;
      }
      const entry = ctx.sessionManager.getEntry(id);
      return entry !== undefined && this.matches(entry, runId, key);
    });
  }
  clear(): void {
    this.published.clear();
    this.completedCursor.reset();
    this.entryIds.clear();
  }
}
