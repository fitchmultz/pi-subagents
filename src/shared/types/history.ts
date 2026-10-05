import type { AcceptanceLedgerStatus } from "./acceptance.ts";
import type {
  ManagementRunState,
  OwnedRun,
  OwnedRunView,
  ReadonlyForegroundResumeRun,
} from "./owned-runs.ts";
import type { SupervisorQuestionView } from "./questions.ts";

export interface HistoryOwner {
  readonly ownerSessionId: string;
  readonly ownerSessionFile?: string;
  readonly runs: readonly OwnedRun[];
  readonly foregroundRuns?: readonly ReadonlyForegroundResumeRun[];
}

export interface HistoryFreshness {
  /** Browse observations only; never proof of completion, ownership, or receipt absence. */
  readonly authoritative: false;
  readonly state: "current" | "catching-up" | "degraded";
  readonly pending: number;
  readonly errors: number;
  readonly indexedAt: number | null;
}

export interface HistoryVersion {
  readonly version: number;
  readonly indexedAt: number | null;
  readonly freshness: HistoryFreshness;
}

export interface HistoryConfiguration {
  readonly model?: string;
  readonly thinking?: string;
  readonly modelRecordedAt?: number;
}

export interface HistoryRunRow extends OwnedRunView {
  readonly summary?: string;
  readonly questions?: readonly SupervisorQuestionView[];
  /** Children satisfying the combined filters, before run pagination. */
  readonly matchedChildIndexes?: readonly number[];
  readonly children: readonly (OwnedRunView["children"][number] & {
    readonly savedConfiguration?: HistoryConfiguration;
    readonly nativeConfiguration?: HistoryConfiguration;
    readonly humanAction?: string;
    readonly acceptanceStatus?: AcceptanceLedgerStatus;
  })[];
}

export interface HistoryRunOptions {
  readonly offset?: number;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: "attention" | "newest" | "oldest";
  readonly agent?: string;
  readonly state?: ManagementRunState;
  readonly text?: string;
  /** Hide only child attempts superseded by an admitted continuation. */
  readonly latestTasksOnly?: boolean;
  readonly signal?: AbortSignal;
}

export interface HistoryRunPage extends HistoryVersion {
  readonly rows: readonly HistoryRunRow[];
  readonly total: number;
  readonly offset: number;
  readonly nextOffset?: number;
  readonly nextCursor?: string;
}

export interface HistoryByteRef {
  readonly sourceId: string;
  readonly generation: number;
  readonly start: number;
  readonly end: number;
  readonly digest: string;
}

export interface HistoryEntry {
  readonly id: string;
  /** Missing in older journals; id then identifies the physical byte range. */
  readonly nativeId: string | null;
  readonly parentId: string | null;
  readonly sequence: number;
  readonly timestamp: number | null;
  readonly type: string;
  readonly ref: HistoryByteRef;
  /** Bounded previews; untrusted detail values require narrowing at their consumer. */
  readonly entry: Readonly<Record<string, unknown>>;
}

export interface HistoryPageInput {
  readonly runId: string;
  readonly index: number;
  readonly limit?: number;
  readonly before?: number;
  readonly after?: number;
  readonly cursor?: string;
  readonly terminalEntryId?: string;
  readonly endedAt?: number;
  /** Configuration ancestry; null is an intentionally empty branch. */
  readonly leaf?: string | null;
  readonly messageIds?: readonly string[];
  readonly readThrough?: string | null;
  readonly signal?: AbortSignal;
}

export interface HistoryPage extends HistoryVersion {
  readonly entries: readonly HistoryEntry[];
  readonly count: number;
  readonly hasMore: boolean;
  readonly previousBefore?: number;
  readonly previousCursor?: string;
  readonly nextAfter?: number;
  readonly sourceId: string | null;
  readonly generation: number | null;
  readonly sessionId: string | null;
  readonly sourceState: string;
  readonly configuration: HistoryConfiguration;
  readonly deliveredMessages: readonly (readonly [string, boolean])[];
  readonly latestEntryId: string | null;
  readonly unreadAfter?: boolean;
  readonly terminalSequence?: number;
  /** Canonical answer match, not a truncated-preview comparison. */
  readonly finalResultId?: string;
  readonly unavailable?: string;
}

export interface HistoryResult {
  readonly text: string;
  readonly timestamp: number;
  readonly finalResultId?: string;
}

export interface HistorySearchInput {
  /** AND tokens or quoted phrase; at most 12 tokens, no operators/prefixes. */
  readonly query: string;
  readonly runId?: string;
  readonly index?: number;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: "relevance" | "newest";
  readonly agent?: string;
  readonly signal?: AbortSignal;
}

export interface HistorySearchMatch {
  readonly id: number;
  readonly runId: string;
  readonly index: number;
  readonly agent: string;
  readonly entryId: string;
  readonly nativeId: string | null;
  readonly sessionId: string | null;
  readonly sessionFile: string;
  readonly timestamp: number | null;
  readonly ref: HistoryByteRef;
  /** Indexed excerpt, not an authoritative/validated full record. */
  readonly preview: string;
  readonly field: string;
  readonly textStart: number;
  readonly textEnd: number;
  readonly score: number;
}

export interface HistorySearchPage extends HistoryVersion {
  readonly matches: readonly HistorySearchMatch[];
  readonly nextCursor?: string;
}

export interface HistoryEntryInput {
  readonly runId: string;
  readonly index: number;
  readonly entryId?: string;
  readonly ref?: HistoryByteRef;
  readonly toolCallId?: string;
  readonly kind?: "call" | "result";
  readonly terminalEntryId?: string;
  readonly endedAt?: number;
  readonly signal?: AbortSignal;
}

export interface HistoryIndexStatus extends HistoryVersion {
  readonly databaseFile: string;
  readonly physicalSources: number;
  readonly publishedEntries: number;
  readonly operations: {
    readonly sourceChecks: number;
    readonly sourceOpens: number;
    readonly sourceBytesRead: number;
    readonly runProjections: number;
    readonly queries: number;
  };
}

/** Public process-owner capability contract; the type model never imports the index implementation. */
export interface HistoryIndexHandle {
  readonly failure: Error | undefined;
  readonly setOwner: (input: HistoryOwner) => Promise<void>;
  readonly updateRun: (run: OwnedRun, foreground?: ReadonlyForegroundResumeRun) => Promise<void>;
  readonly needsControls: () => Promise<boolean>;
  readonly listRuns: (options?: HistoryRunOptions) => Promise<HistoryRunPage>;
  readonly historyPage: (input: HistoryPageInput) => Promise<HistoryPage>;
  readonly search: (input: HistorySearchInput) => Promise<HistorySearchPage>;
  readonly status: () => Promise<HistoryIndexStatus>;
  readonly entry: (input: HistoryEntryInput) => Promise<HistoryEntry | null>;
  readonly record: (input: HistoryEntryInput) => Promise<Record<string, unknown> | null>;
  readonly result: (
    input: Pick<HistoryEntryInput, "runId" | "index" | "signal">,
  ) => Promise<HistoryResult | null>;
  readonly refresh: (runId?: string, options?: { readonly signal?: AbortSignal }) => Promise<void>;
  readonly onChanged: (listener: () => void) => () => void;
  readonly cancel: () => void;
  readonly close: () => Promise<void>;
}
