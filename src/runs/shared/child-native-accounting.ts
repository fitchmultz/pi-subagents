import type { ReadonlyInput, Usage, UsageAccumulator } from "../../shared/types.ts";
import { NativeJournal } from "../../shared/journal-reader.ts";
import type { ChildAttemptResult, ChildObservation } from "./child-attempt-types.ts";
import { readNativeUsage, nativeUsageCollector, type NativeUsageMetadata } from "./native-usage.ts";
import { sumAttemptUsage } from "./model-fallback.ts";
import { errorMessage as errorText } from "../../shared/unknown.ts";
import { nonempty } from "./child-presence.ts";
import { optionalString } from "./child-message-validation.ts";

interface AccountingInput {
  readonly file?: string;
  readonly result: ReadonlyInput<ChildAttemptResult>;
  readonly baseline: Readonly<ReadonlySet<string>>;
  readonly acceptedEntries: Readonly<ReadonlyMap<string, NativeUsageMetadata>>;
  readonly reference: (entry: NativeUsageMetadata) => ChildObservation | undefined;
  readonly observations: () => readonly ChildObservation[];
}
export interface NativeAccountingResult {
  readonly publishedIds: Readonly<ReadonlySet<string>>;
  readonly accounting: NonNullable<ChildAttemptResult["accounting"]>;
  readonly usage?: UsageAccumulator;
  readonly segmentUsage?: readonly Usage[];
  readonly nativeSessionId?: string;
  readonly terminalEntryId?: string;
  readonly terminalLeafId?: string | null;
  readonly effectiveConfiguration?: ChildAttemptResult["effectiveConfiguration"];
}

function verifyObservedCommits(
  observations: readonly ChildObservation[],
  publishedIds: Readonly<ReadonlySet<string>>,
): void {
  const missing = observations.some((item) => {
    if (!item.message) {
      return false;
    }
    const billable =
      item.message.role === "assistant" ||
      (item.message.role === "toolResult" && item.message.usage !== undefined);
    return billable && (item.nativeEntryId === undefined || !publishedIds.has(item.nativeEntryId));
  });
  if (missing) {
    throw new Error(
      "Finalized message usage has no verified native commit; its reported usage and audit remain available.",
    );
  }
}

function acceptedTotals(input: AccountingInput): readonly Usage[] | undefined {
  if (!nonempty(input.result.nativeSessionId) || input.acceptedEntries.size === 0) {
    return;
  }
  const accepted = nativeUsageCollector(
    input.result.nativeSessionId,
    input.baseline,
    input.result.finalization?.map((segment) => segment.event.lastEntryId),
  );
  for (const entry of input.acceptedEntries.values()) {
    accepted.append(entry);
  }
  return accepted.totals;
}

/** Publication, not message_end, authorizes complete native accounting. */
export function accountNativeChild(input: AccountingInput): NativeAccountingResult {
  const publishedIds = new Set<string>();
  let nativeSessionId = input.result.nativeSessionId;
  let terminalEntryId = input.result.terminalEntryId;
  let accounting: NonNullable<ChildAttemptResult["accounting"]> = input.result.accounting ?? {
    state: "complete",
  };
  let usage: UsageAccumulator | undefined;
  let segmentUsage: readonly Usage[] | undefined;
  try {
    const native = readNativeUsage(
      input.file,
      input.baseline,
      input.result.finalization?.map((segment) => segment.event.lastEntryId),
      {
        onEntry: (entry) => {
          if (entry.type === "message") {
            publishedIds.add(entry.id);
            if (!input.baseline.has(entry.id)) {
              input.reference(entry);
            }
          }
        },
        onBoundary: (boundary) => {
          nativeSessionId = boundary.sessionId;
          terminalEntryId = boundary.lastEntryId;
        },
      },
    );
    const totals = native ?? acceptedTotals(input);
    if (totals) {
      if (native) {
        verifyObservedCommits(input.observations(), publishedIds);
      }
      accounting = { state: "complete" };
      const total = sumAttemptUsage(
        totals.map((item) => ({
          model: input.result.model ?? "default",
          success: true,
          usage: item,
        })),
      );
      usage = { ...total, contributions: total.contributions?.slice() };
      segmentUsage = totals;
    }
  } catch (error) {
    accounting = {
      state: "incomplete",
      error: `Cannot read finalized native usage: ${errorText(error)}`,
    };
  }
  const selection = terminalSelection(input.file, input.result, terminalEntryId, accounting);
  return { ...selection, publishedIds, nativeSessionId, usage, segmentUsage };
}

function terminalSelection(
  file: string | undefined,
  result: ReadonlyInput<ChildAttemptResult>,
  terminalEntryId: string | undefined,
  accounting: Readonly<NonNullable<ChildAttemptResult["accounting"]>>,
): Pick<
  NativeAccountingResult,
  "accounting" | "effectiveConfiguration" | "terminalEntryId" | "terminalLeafId"
> {
  let selectedEntryId = terminalEntryId;
  let selectionAccounting = accounting;
  let terminalLeafId = result.terminalLeafId;
  let effectiveConfiguration = result.effectiveConfiguration;
  if (effectiveConfiguration || !nonempty(file)) {
    return { accounting, effectiveConfiguration, terminalEntryId, terminalLeafId };
  }
  try {
    const journal = new NativeJournal(file, "inspect", true);
    const terminal = journal.records.findLast((record) => record.value.type !== "session");
    selectedEntryId ??= optionalString(terminal?.value.id, "terminal native ID");
    terminalLeafId ??= selectedEntryId;
    effectiveConfiguration = journal.configuration(undefined, terminalLeafId);
  } catch (error) {
    selectionAccounting = {
      state: "incomplete",
      error: accounting.error ?? `Cannot capture terminal native selection: ${errorText(error)}`,
    };
  }
  return {
    accounting: selectionAccounting,
    effectiveConfiguration,
    terminalEntryId: selectedEntryId,
    terminalLeafId,
  };
}
