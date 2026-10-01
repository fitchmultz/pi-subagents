import type { AcceptanceLedgerStatus, ForegroundResumeRun, ManagementRunState, OwnedRun, OwnedRunView } from "../shared/types.ts";
import type { SupervisorQuestionView } from "../runs/shared/supervisor-questions.ts";

export type { ForegroundResumeRun, ManagementRunState, OwnedRun, OwnedRunView };
export interface HistoryOwner {
	ownerSessionId: string;
	ownerSessionFile?: string;
	runs: OwnedRun[];
	foregroundRuns?: ForegroundResumeRun[];
}
export interface HistoryFreshness {
	/** Browse observations only; never proof of completion, ownership, or receipt absence. */
	authoritative: false;
	state: "current" | "catching-up" | "degraded";
	pending: number;
	errors: number;
	indexedAt: number | null;
}
export interface HistoryVersion {
	version: number;
	indexedAt: number | null;
	freshness: HistoryFreshness;
}
export interface HistoryConfiguration { model?: string; thinking?: string; modelRecordedAt?: number }
export interface HistoryRunRow extends OwnedRunView {
	summary?: string;
	questions?: SupervisorQuestionView[];
	/** Children satisfying the combined filters, before run pagination. */
	matchedChildIndexes?: number[];
	children: Array<OwnedRunView["children"][number] & { savedConfiguration?: HistoryConfiguration; nativeConfiguration?: HistoryConfiguration; humanAction?: string; acceptanceStatus?: AcceptanceLedgerStatus }>;
}
export interface HistoryRunOptions {
	offset?: number;
	limit?: number;
	cursor?: string;
	sort?: "attention" | "newest" | "oldest";
	agent?: string;
	state?: ManagementRunState;
	text?: string;
	/** Hide only child attempts superseded by an admitted continuation. */
	latestTasksOnly?: boolean;
	signal?: AbortSignal;
}
export interface HistoryRunPage extends HistoryVersion {
	rows: HistoryRunRow[];
	total: number;
	offset: number;
	nextOffset?: number;
	nextCursor?: string;
}
export interface HistoryByteRef {
	sourceId: string;
	generation: number;
	start: number;
	end: number;
	digest: string;
}
export interface HistoryEntry {
	id: string;
	/** Missing in older journal formats; id then identifies the physical byte range. */
	nativeId: string | null;
	parentId: string | null;
	sequence: number;
	timestamp: number | null;
	type: string;
	ref: HistoryByteRef;
	/** Safe bounded text, thinking, and argument previews; images and raw details are not hydrated. */
	entry: Record<string, any>;
}
export interface HistoryPageInput {
	runId: string;
	index: number;
	limit?: number;
	/** Exclusive physical sequence. Omit to read the latest page. */
	before?: number;
	/** Exclusive sequence for forward traversal; mutually exclusive with before. */
	after?: number;
	cursor?: string;
	terminalEntryId?: string;
	endedAt?: number;
	/** Configuration ancestry; null is an intentionally empty branch. */
	leaf?: string | null;
	/** Only known outgoing IDs are returned, at most 1000. */
	messageIds?: string[];
	readThrough?: string | null;
	signal?: AbortSignal;
}
export interface HistoryPage extends HistoryVersion {
	entries: HistoryEntry[];
	count: number;
	hasMore: boolean;
	previousBefore?: number;
	previousCursor?: string;
	nextAfter?: number;
	sourceId: string | null;
	generation: number | null;
	sessionId: string | null;
	sourceState: string;
	configuration: HistoryConfiguration;
	deliveredMessages: Array<[string, boolean]>;
	latestEntryId: string | null;
	unreadAfter?: boolean;
	terminalSequence?: number;
	/** Exact canonical answer match: prefer this page, otherwise locate the latest in the attempt. Never compare truncated previews. */
	finalResultId?: string;
	unavailable?: string;
}
export interface HistoryResult { text: string; timestamp: number; finalResultId?: string }
export interface HistorySearchInput {
	/** Whitespace-separated tokens (AND), or a quoted phrase, at most 12 tokens. No operators/prefixes. */
	query: string;
	runId?: string;
	index?: number;
	limit?: number;
	cursor?: string;
	sort?: "relevance" | "newest";
	agent?: string;
	signal?: AbortSignal;
}
export interface HistorySearchMatch {
	id: number;
	runId: string;
	index: number;
	agent: string;
	entryId: string;
	nativeId: string | null;
	sessionId: string | null;
	sessionFile: string;
	timestamp: number | null;
	ref: HistoryByteRef;
	/** Indexed excerpt, not an authoritative/validated full record. */
	preview: string;
	field: string;
	textStart: number;
	textEnd: number;
	score: number;
}
export interface HistorySearchPage extends HistoryVersion {
	matches: HistorySearchMatch[];
	nextCursor?: string;
}
export interface HistoryEntryInput {
	runId: string;
	index: number;
	entryId?: string;
	ref?: HistoryByteRef;
	/** Find the call or result even when its paired entry is on another page. */
	toolCallId?: string;
	kind?: "call" | "result";
	terminalEntryId?: string;
	endedAt?: number;
	signal?: AbortSignal;
}
export class HistoryIndexError extends Error {
	readonly code: string;
	constructor(code: string, message: string) { super(message); this.name = "HistoryIndexError"; this.code = code; }
}
export interface HistoryIndexStatus extends HistoryVersion {
	databaseFile: string;
	physicalSources: number;
	publishedEntries: number;
	/** Process-local operational counters, useful for catch-up/latency diagnostics. */
	operations: { sourceChecks: number; sourceOpens: number; sourceBytesRead: number; runProjections: number; queries: number };
}
export interface Request { id: number; method: string; input?: any }
export type Response = { id: number; value?: any; error?: { code: string; message: string } } | { changed: true };
