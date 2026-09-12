/**
 * Type definitions for the subagent extension
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

// ============================================================================
// Basic Types
// ============================================================================

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export type OutputMode = "inline" | "file-only";

export type JsonSchemaObject = Record<string, unknown>;

export interface ChainOutputMapEntry {
	text: string;
	structured?: unknown;
	agent: string;
	stepIndex: number;
}

export type ChainOutputMap = Record<string, ChainOutputMapEntry>;

export type WorkflowNodeStatus = "pending" | "running" | "completed" | "complete" | "failed" | "blocked" | "paused" | "detached" | "timed-out";

export interface WorkflowGraphNode {
	id: string;
	kind: "step" | "parallel-group" | "dynamic-parallel-group" | "agent";
	agent?: string;
	phase?: string;
	label: string;
	status: WorkflowNodeStatus;
	flatIndex?: number;
	stepIndex?: number;
	children?: WorkflowGraphNode[];
	dynamic?: {
		sourceOutput: string;
		sourcePath: string;
		itemName: string;
		maxItems?: number;
		collectAs?: string;
	};
	itemKey?: string;
	outputName?: string;
	structured?: boolean;
	acceptanceStatus?: AcceptanceLedgerStatus;
	error?: string;
}

export interface WorkflowGraphSnapshot {
	runId: string;
	mode: "chain" | "parallel" | "single";
	phases: Array<{ title: string; nodeIds: string[] }>;
	nodes: WorkflowGraphNode[];
	currentNodeId?: string;
}

export interface SavedOutputReference {
	path: string;
	bytes: number;
	lines: number;
	message: string;
}

interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export type ActivityState = "needs_attention";
export type ControlEventType = "needs_attention";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	failedToolAttemptsBeforeAttention?: number;
	notifyOn?: ControlEventType[];
	notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
}

export interface ControlEvent {
	type: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	message: string;
	reason?: "idle" | "completion_guard" | "tool_failures";
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
	supervisorQuestion?: { questionId: string; state: "awaiting_input" | "answer_pending"; answer?: string };
}

export type SubagentResultStatus = "completed" | "failed" | "blocked" | "paused" | "detached" | "timed-out";
export type SubagentRunMode = "single" | "parallel" | "chain";

export type PublicNestedStepSummary = Pick<
	NestedStepSummary,
	"agent" | "status" | "sessionFile" | "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount" | "startedAt" | "endedAt" | "error"
> & {
	children?: PublicNestedRunSummary[];
};

export type PublicNestedRunSummary = Pick<
	NestedRunSummary,
	"id" | "parentRunId" | "parentStepIndex" | "parentAgent" | "depth" | "path" | "asyncDir" | "sessionId" | "sessionFile" | "intercomTarget" | "ownerIntercomTarget" | "leafIntercomTarget" | "ownerState" | "mode" | "state" | "agent" | "agents" | "currentStep" | "chainStepCount" | "parallelGroups" | "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount" | "totalTokens" | "startedAt" | "endedAt" | "lastUpdate" | "error"
> & {
	steps?: PublicNestedStepSummary[];
	children?: PublicNestedRunSummary[];
};

export interface SubagentResultIntercomChild {
	agent: string;
	status: SubagentResultStatus;
	summary: string;
	index?: number;
	artifactPath?: string;
	metadataPath?: string;
	sessionPath?: string;
	intercomTarget?: string;
	children?: PublicNestedRunSummary[];
}

export interface SubagentResultIntercomPayload {
	to: string;
	message: string;
	requestId?: string;
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	summary: string;
	error?: string;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	resultPath?: string;
	asyncId?: string;
	asyncDir?: string;
	chainSteps?: number;
	agent?: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface AgentProgress {
	index: number;
	agent: string;
	status: "pending" | "running" | "completed" | "complete" | "failed" | "blocked" | "paused" | "detached" | "timed-out";
	activityState?: ActivityState;
	task: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	streamingText?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	turnCount?: number;
	tokens: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
}

export interface ToolCallSummary {
	text: string;
	expandedText: string;
}

interface ProgressSummary extends Partial<Pick<AgentProgress,
	"index" | "agent" | "status" | "activityState" | "task" | "skills" | "lastActivityAt" | "currentTool" | "currentToolArgs" | "currentToolStartedAt" | "currentPath" | "recentTools" | "recentOutput" | "turnCount" | "error" | "failedTool"
>> {
	toolCount: number;
	tokens: number;
	durationMs: number;
}

// ============================================================================
// Results
// ============================================================================

export interface ModelAttempt {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export type AcceptanceProvenanceLevel = "none" | "attested" | "checked" | "verified";

export type AcceptanceEvidenceKind =
	| "changed-files"
	| "tests-added"
	| "commands-run"
	| "validation-output"
	| "residual-risks"
	| "no-staged-files"
	| "diff-summary"
	| "review-findings"
	| "manual-notes";

export interface AcceptanceGate {
	id: string;
	must: string;
	evidence?: AcceptanceEvidenceKind[];
	severity?: "required" | "recommended";
}

export interface AcceptanceVerifyCommand {
	id: string;
	command: string;
	timeoutMs?: number;
	cwd?: string;
	env?: Record<string, string>;
	allowFailure?: boolean;
}

export interface AcceptanceConfig {
	criteria?: Array<string | AcceptanceGate>;
	evidence?: AcceptanceEvidenceKind[];
	verify?: AcceptanceVerifyCommand[];
	stopRules?: string[];
	maxFinalizationTurns?: number;
}

export type AcceptanceInput = AcceptanceConfig;

export interface ResolvedAcceptanceGate extends AcceptanceGate {
	id: string;
	must: string;
	evidence: AcceptanceEvidenceKind[];
	severity: "required" | "recommended";
}

export interface ResolvedAcceptanceConfig {
	level: AcceptanceProvenanceLevel;
	explicit: boolean;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	evidence: AcceptanceEvidenceKind[];
	verify: AcceptanceVerifyCommand[];
	stopRules: string[];
	finalization: {
		mode: "none" | "self-review-loop";
		maxTurns: number;
	};
}

export interface AcceptanceReport {
	criteriaSatisfied?: Array<{
		id?: string;
		status: "satisfied" | "not-satisfied" | "not-applicable" | "blocked";
		evidence: string;
		humanAction?: string;
	}>;
	changedFiles?: string[];
	testsAddedOrUpdated?: string[];
	commandsRun?: Array<{
		command: string;
		result: "passed" | "failed" | "not-run";
		summary: string;
	}>;
	validationOutput?: string[];
	residualRisks?: string[];
	noStagedFiles?: boolean;
	diffSummary?: string;
	reviewFindings?: Array<string | Record<string, unknown>>;
	manualNotes?: string;
	notes?: string;
}

export type AcceptanceRuntimeCheckStatus = "passed" | "failed" | "blocked" | "not-applicable";

export interface AcceptanceRuntimeCheck {
	id: string;
	status: AcceptanceRuntimeCheckStatus;
	message: string;
}

export interface AcceptanceVerifyResult {
	id: string;
	command: string;
	cwd?: string;
	exitCode: number | null;
	status: "passed" | "failed" | "timed-out" | "allowed-failure";
	stdout?: string;
	stderr?: string;
	durationMs: number;
}

export type AcceptanceLedgerStatus =
	| "not-required"
	| "claimed"
	| "attested"
	| "checked"
	| "verified"
	| "accepted"
	| "blocked"
	| "rejected";

export interface AcceptanceFinalizationTurn {
	turn: number;
	prompt: string;
	status: AcceptanceLedgerStatus;
	rawOutput?: string;
	unconfirmedOutput?: string;
	report?: AcceptanceReport;
	parseError?: string;
	runtimeChecks: AcceptanceRuntimeCheck[];
	verifyRuns: AcceptanceVerifyResult[];
	failureMessage?: string;
}

export interface AcceptanceFinalizationLedger {
	mode: "self-review-loop";
	status: "not-run" | "completed" | "blocked" | "failed";
	maxTurns: number;
	turns: AcceptanceFinalizationTurn[];
}

export interface AcceptanceLedger {
	status: AcceptanceLedgerStatus;
	explicit: boolean;
	effectiveAcceptance: ResolvedAcceptanceConfig;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	childReport?: AcceptanceReport;
	childReportParseError?: string;
	initialChildReport?: AcceptanceReport;
	initialChildReportParseError?: string;
	/** Prior full report retained as audit evidence, never as current acceptance. */
	unconfirmedOutput?: string;
	runtimeChecks: AcceptanceRuntimeCheck[];
	verifyRuns: AcceptanceVerifyResult[];
	finalization?: AcceptanceFinalizationLedger;
}

export interface ResourceLimitExceeded {
	kind: "maxExecutionTimeMs" | "maxTokens";
	limit: number;
	observed?: number;
	message: string;
}

export interface AgentProcessExit {
	pid?: number;
	code: number | null;
	signal: NodeJS.Signals | null;
	at: number;
}

export interface SingleResult {
	agent: string;
	agentProcessExit?: AgentProcessExit;
	task: string;
	exitCode: number;
	detached?: boolean;
	detachedReason?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	resourceLimitExceeded?: ResourceLimitExceeded;
	messages?: Message[];
	usage: Usage;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	controlEvents?: ControlEvent[];
	error?: string;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	initialOutput?: string;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputReference?: SavedOutputReference;
	outputSaveError?: string;
	outputCleanup?: { path: string; action: "deleted" | "already-missing" | "skipped"; reason?: string; error?: string };
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
}

export type ManagementRunState = "live" | "completed" | "paused" | "blocked" | "failed" | "unknown";
export type ManagementAction = "status" | "nudge" | "resume" | "wait" | "interrupt" | "extend" | "review";

export interface SavedLaunchConfig {
	agent: import("../agents/agents.ts").AgentConfig;
	model?: string;
	thinking?: string;
	modelCandidates: string[];
	artifacts: boolean;
	artifactsDir?: string;
	share: boolean;
	systemPrompt: string;
	skills: string[];
	cwd: string;
	context: "fresh" | "fork";
	output: string | false;
	/** Proven generated output filename, independent of the selected profile; absent on legacy snapshots. */
	generatedOutputFilename?: string;
	outputMode: OutputMode;
	outputSchema?: JsonSchemaObject;
	effectiveAcceptance?: ResolvedAcceptanceConfig;
	maxOutput?: MaxOutputConfig;
	maxSubagentDepth?: number;
	maxExecutionTimeMs?: number;
	maxTokens?: number;
	controlConfig?: ResolvedControlConfig;
	projectTrust?: ChildProjectTrustPolicy;
	projectTrusted?: boolean;
}

export interface ParentRunReview {
	decision: "accepted" | "needs_changes";
	message?: string;
	reviewedAt: number;
}

export interface OwnedRun {
	runId: string;
	ownerSessionId: string;
	source: "foreground" | "async";
	mode: SubagentRunMode;
	cwd: string;
	task: string;
	startedAt: number;
	rootRunId: string;
	predecessorRunId?: string;
	predecessorIndex?: number;
	asyncDir?: string;
	pid?: number;
	children: Array<{ agent: string; index: number; workflowNodeId?: string; task?: string; label?: string; sessionFile?: string }>;
	review?: ParentRunReview;
	delivery?: { notifiedAt: number; intercomDelivered: boolean };
	legacy?: boolean;
	error?: string;
}

export interface OwnedRunView extends OwnedRun {
	state: ManagementRunState;
	updatedAt: number;
	attention: string[];
	children: Array<OwnedRun["children"][number] & {
		state: ManagementRunState;
		result?: Omit<SingleResult, "artifactPaths"> & { artifactPaths?: Partial<ArtifactPaths> };
		launch?: SavedLaunchConfig;
		configuration: "saved" | "legacy-partial";
		missingSession?: boolean;
		activity?: Partial<Pick<AgentProgress, "status" | "currentTool" | "currentToolArgs" | "currentPath" | "recentOutput" | "lastActivityAt" | "streamingText">>;
	}>;
	continuations: Array<{ runId: string; predecessorRunId: string; predecessorIndex?: number }>;
	resultPath?: string;
	canInterrupt: boolean;
	diagnosis?: string;
}

export interface ManagementControl {
	state: ManagementRunState;
	runId: string;
	capabilities: ManagementAction[];
	nextActions: Array<{
		action: ManagementAction;
		runId: string;
		index?: number;
		intercomTarget?: string;
	}>;
	unavailableActions?: Partial<Record<ManagementAction, string>>;
	revivedFromRunId?: string;
	pendingReplyContextValid?: boolean;
}

export interface Details {
	mode: SubagentRunMode | "management";
	runId?: string;
	context?: "fresh" | "fork";
	results: SingleResult[];
	controlEvents?: ControlEvent[];
	asyncId?: string;
	asyncDir?: string;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	intercomTargets?: string[];
	managementControl?: ManagementControl;
	managementControls?: ManagementControl[];
	questions?: import("../runs/shared/supervisor-questions.ts").SupervisorQuestionView[];
	wait?: { runId: string; index?: number; status: "completed" | "cancelled" | "yielded" | "awaiting_input" | "unavailable" };
	run?: OwnedRunView;
	runs?: Array<Pick<OwnedRunView, "runId" | "source" | "mode" | "cwd" | "task" | "state" | "updatedAt" | "attention" | "review" | "rootRunId" | "predecessorRunId" | "predecessorIndex"> & { summary?: string; continuations?: string[] }>;
	runList?: { total: number; offset: number; limit: number; nextOffset?: number };
	intercomDelivery?: {
		delivered: boolean;
		to: string;
		status: SubagentResultStatus;
		summary: string;
	};
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
	// Chain metadata for observability
	chainAgents?: string[];      // Agent names in order, e.g., ["scout", "planner"]
	totalSteps?: number;         // Total steps in chain
	currentStepIndex?: number;   // 0-indexed current step (for running chains)
	workflowGraph?: WorkflowGraphSnapshot;
	outputs?: ChainOutputMap;
}

export type SubagentExecutionResult = AgentToolResult<Details> & {
	/** Executor error marker; registered tools transfer it through Pi's native tool_result hook. */
	isError?: boolean;
};

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	metadataPath: string;
}

// ============================================================================
// Async Execution
// ============================================================================

export interface AsyncParallelGroupStatus {
	start: number;
	count: number;
	stepIndex: number;
}

export type AsyncResultTerminalState = "complete" | "failed" | "blocked" | "paused";

export interface AsyncResultChild {
	agent?: string;
	agentProcessExit?: AgentProcessExit;
	exitCode?: number | null;
	output?: string;
	error?: string;
	success?: boolean;
	skipped?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: Partial<ArtifactPaths>;
	truncated?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	resourceLimitExceeded?: ResourceLimitExceeded;
	interrupted?: boolean;
	children?: unknown;
}

export interface AsyncResultFile {
	id?: string;
	runId?: string;
	agent?: string;
	mode?: SubagentRunMode;
	success?: boolean;
	state?: string;
	summary?: string;
	results?: AsyncResultChild[];
	outputs?: ChainOutputMap;
	workflowGraph?: WorkflowGraphSnapshot;
	exitCode?: number;
	timestamp?: number;
	durationMs?: number;
	truncated?: boolean;
	artifactsDir?: string;
	cwd?: string;
	asyncDir?: string;
	sessionId?: string;
	sessionFile?: string;
	intercomTarget?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	taskIndex?: number;
	totalTasks?: number;
	nestedChildren?: unknown;
}

export type NestedRunState = "queued" | "running" | "complete" | "failed" | "blocked" | "paused";
export type NestedOwnerState = "live" | "gone" | "unknown";

export interface NestedRunAddress {
	id: string;
	parentRunId: string;
	parentStepIndex?: number;
	parentAgent?: string;
	depth: number;
	path: Array<{ runId: string; stepIndex?: number; agent?: string }>;
}

export interface NestedStepSummary {
	agent: string;
	status: "pending" | "running" | "complete" | "completed" | "failed" | "blocked" | "paused" | "timed-out";
	sessionFile?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	children?: NestedRunSummary[];
}

export interface NestedRunSummary extends NestedRunAddress {
	indexedControl?: boolean;
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	sessionFile?: string;
	intercomTarget?: string;
	ownerIntercomTarget?: string;
	leafIntercomTarget?: string;
	ownerState?: NestedOwnerState;
	controlInbox?: string;
	capabilityToken?: string;
	mode?: SubagentRunMode;
	state: NestedRunState;
	agent?: string;
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: NestedStepSummary[];
	children?: NestedRunSummary[];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	totalTokens?: TokenUsage;
	startedAt?: number;
	endedAt?: number;
	lastUpdate?: number;
	error?: string;
}

export interface NestedRouteInfo {
	rootRunId: string;
	eventSink: string;
	controlInbox: string;
	capabilityToken: string;
}

export interface AsyncStartedEvent {
	id?: string;
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agent?: string;
	agents?: string[];
	chain?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
}

export interface AsyncStatus {
	runId: string;
	indexedControl?: boolean;
	controlRequestFiles?: boolean;
	sessionId?: string;
	mode: SubagentRunMode;
	state: "queued" | "running" | "complete" | "failed" | "blocked" | "paused";
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	pid?: number;
	cwd?: string;
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	steps?: Array<{
		agent: string;
		phase?: string;
		label?: string;
		outputName?: string;
		structured?: boolean;
		status: "pending" | "running" | "complete" | "completed" | "failed" | "blocked" | "paused" | "timed-out";
		children?: NestedRunSummary[];
		sessionFile?: string;
		activityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolArgs?: string;
		streamingText?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		recentTools?: Array<{ tool: string; args: string; endMs: number }>;
		recentOutput?: string[];
		turnCount?: number;
		toolCount?: number;
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		exitCode?: number | null;
		agentProcessExit?: AgentProcessExit;
		tokens?: TokenUsage;
		skills?: string[];
		model?: string;
		thinking?: string;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
		error?: string;
		structuredOutput?: unknown;
		structuredOutputPath?: string;
		structuredOutputSchemaPath?: string;
		acceptance?: AcceptanceLedger;
		resourceLimitExceeded?: ResourceLimitExceeded;
	}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	outputs?: ChainOutputMap;
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & {
	index?: number;
};

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "complete" | "failed" | "blocked" | "paused";
	pid?: number;
	sessionId?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	mode?: SubagentRunMode;
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: AsyncJobStep[];
	stepsTotal?: number;
	runningSteps?: number;
	completedSteps?: number;
	activeParallelGroup?: boolean;
	startedAt?: number;
	updatedAt?: number;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	controlEventCursor?: number;
	controlEventSince?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
}

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	sessionFile?: string;
	status: SubagentResultStatus;
	summary?: string;
	artifactPath?: string;
	effectiveAcceptance?: ResolvedAcceptanceConfig;
	result?: SingleResult;
}

export interface ForegroundResumeRun {
	runId: string;
	mode: SubagentRunMode;
	cwd: string;
	updatedAt: number;
	error?: string;
	/** Logical work left after detachment, independent of child success. */
	pausedReason?: string;
	children: ForegroundResumeChild[];
}

export interface TimeoutExtensionResult {
	ok: boolean;
	timeoutAt?: number;
	message: string;
}

export type TimeoutExtensionCallback = (additionalMs: number) => TimeoutExtensionResult;

export interface ForegroundActiveChildControl {
	agent: string;
	interrupt?: () => boolean;
}

export interface ForegroundControlState {
	runId: string;
	mode: SubagentRunMode;
	startedAt: number;
	updatedAt: number;
	currentAgent?: string;
	currentIndex?: number;
	currentActivityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	toolCount?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
	activeChildren?: Map<number, ForegroundActiveChildControl>;
	progress?: AgentProgress[];
	timeoutAt?: number;
	extendTimeout?: TimeoutExtensionCallback;
	interrupt?: () => boolean;
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	asyncJobs: Map<string, AsyncJobState>;
	foregroundRuns?: Map<string, ForegroundResumeRun>;
	ownedRuns?: Map<string, OwnedRun>;
	persistOwnedRun?: (run: OwnedRun) => void;
	onRunsChanged?: () => void;
	foregroundControls: Map<string, ForegroundControlState>;
	lastForegroundControlId: string | null;
	pendingForegroundControlNotices?: Map<string, ReturnType<typeof setTimeout>>;
	cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
	poller: NodeJS.Timeout | null;
	completionSeen: Map<string, number>;
	watcher: FSWatcher | null;
	watcherRestartTimer: ReturnType<typeof setTimeout> | null;
	resultFileCoalescer: {
		schedule(file: string, delayMs?: number): boolean;
		clear(): void;
	};
}

// ============================================================================
// Display
// ============================================================================

export type DisplayItem = 
	| { type: "text"; text: string } 
	| { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
export const SUBAGENT_LIVE_INTERCOM_EVENT = "subagent:live-intercom";
export const SUBAGENT_LIVE_INTERCOM_DELIVERY_EVENT = "subagent:live-intercom-delivery";
export const SUBAGENT_INTERCOM_HEALTH_REQUEST_EVENT = "subagent:intercom-health-request";
export const SUBAGENT_INTERCOM_HEALTH_RESPONSE_EVENT = "subagent:intercom-health-response";
export const SUBAGENT_INTERCOM_IDENTITY_REQUEST_EVENT = "subagent:intercom-identity-request";
export const SUBAGENT_INTERCOM_IDENTITY_RESPONSE_EVENT = "subagent:intercom-identity-response";

export interface SubagentIntercomConnection {
	status: "connected" | "disconnected" | "connecting" | "unknown";
	sessionId?: string;
	reason?: string;
}

export interface SubagentLiveIntercomHealth {
	target: string;
	status: "registered" | "none" | "missing" | "ambiguous" | "prefix_too_short";
	sessionId?: string;
	sessionName?: string;
	sessionStatus?: string;
	acceptsAsks?: boolean;
	pendingAsks?: number;
}

// ============================================================================
// Execution Options
// ============================================================================

export interface RunSyncOptions {
	cwd?: string;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	timeoutMs?: number;
	timeoutAt?: number;
	registerTimeoutExtension?: (extend: TimeoutExtensionCallback) => void;
	allowIntercomDetach?: boolean;
	onDetachedComplete?: (result: SingleResult) => void | Promise<void>;
	onRunSettled?: () => void;
	intercomEvents?: IntercomEventBus;
	onUpdate?: (r: SubagentExecutionResult) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig?: ResolvedControlConfig;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	runId: string;
	index?: number;
	sessionDir?: string;
	sessionFile?: string;
	share?: boolean;
	outputPath?: string;
	outputPathFromAgentDefault?: boolean;
	outputMode?: OutputMode;
	/** When true, an inline output file is left in place (workspace/cwd) instead of being consumed after capture. */
	persistOutputFile?: boolean;
	maxSubagentDepth?: number;
	maxExecutionTimeMs?: number;
	maxTokens?: number;
	nestedRoute?: NestedRouteInfo;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Skills to inject (overrides agent default if provided) */
	skills?: string[];
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	projectTrust?: ChildProjectTrustPolicy;
	projectTrusted?: boolean;
	acceptance?: AcceptanceInput;
}

export type ChildProjectTrustPolicy = "inherit" | "approve" | "no-approve";

export interface ProjectTrustConfig {
	childRuns?: ChildProjectTrustPolicy;
}

interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
}

interface ExtensionChainConfig {
	dynamicFanout?: {
		maxItems?: number;
	};
}

export interface ExtensionConfig {
	asyncByDefault?: boolean;
	forceTopLevelAsync?: boolean;
	defaultSessionDir?: string;
	maxSubagentDepth?: number;
	control?: ControlConfig;
	parallel?: TopLevelParallelConfig;
	chain?: ExtensionChainConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	projectTrust?: ChildProjectTrustPolicy | ProjectTrustConfig;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
	bytes: 200 * 1024,
	lines: 5000,
};

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

export function resolveTempScopeId(options?: {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
}): string {
	const env = options?.env ?? process.env;
	const getuid = options && Object.hasOwn(options, "getuid")
		? options.getuid
		: process.getuid?.bind(process);
	if (typeof getuid === "function") {
		return `uid-${getuid()}`;
	}

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const userInfo = options && Object.hasOwn(options, "userInfo")
		? options.userInfo
		: os.userInfo;
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}

	const homedir = env.HOME;
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

	const resolveHomedir = options && Object.hasOwn(options, "homedir")
		? options.homedir
		: os.homedir;
	try {
		const fallbackHomedir = resolveHomedir?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}

	return "shared";
}

const MAX_PARALLEL = 8;
export const MAX_CONCURRENCY = 4;

export function resolveTempRootDir(configured = process.env.PI_SUBAGENT_TEMP_ROOT): string {
	const fallback = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
	if (!configured?.trim()) return fallback;
	const resolved = path.resolve(configured);
	if (!path.basename(resolved).startsWith("pi-subagents-")) {
		throw new Error("PI_SUBAGENT_TEMP_ROOT must name a dedicated 'pi-subagents-*' directory.");
	}
	return resolved;
}

export const TEMP_ROOT_DIR = resolveTempRootDir();
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const RUNNER_ERROR_LOG_FILE = "runner-error.log";
export const CHAIN_RUNS_DIR = path.join(TEMP_ROOT_DIR, "chain-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");
export const WIDGET_KEY = "subagent-async";
export const SLASH_RESULT_TYPE = "subagent-slash-result";
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
export const POLL_INTERVAL_MS = 1000;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;
export const SUBAGENT_ACTIONS = ["list", "get", "create", "update", "delete", "status", "interrupt", "extend", "resume", "wait", "nudge", "questions", "answer", "review", "doctor"] as const;

export const DEFAULT_FORK_PREAMBLE =
	"You are a delegated subagent running from a fork of the parent session. " +
	"Treat the inherited conversation as reference-only context, not a live thread to continue. " +
	"Do not continue or answer prior messages as if they are waiting for a reply. " +
	"Your sole job is to execute the task below and return a focused result for that task using your tools.";

function normalizeTopLevelParallelValue(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

export function resolveTopLevelParallelMaxTasks(value: unknown): number {
	return normalizeTopLevelParallelValue(value) ?? MAX_PARALLEL;
}

export function resolveTopLevelParallelConcurrency(
	override: unknown,
	configValue: unknown,
): number {
	return normalizeTopLevelParallelValue(override)
		?? normalizeTopLevelParallelValue(configValue)
		?? MAX_CONCURRENCY;
}

export function getAsyncConfigPath(suffix: string): string {
	return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}

export function wrapForkTask(task: string, preamble?: string | false): string {
	if (preamble === false) return task;
	const effectivePreamble = preamble ?? DEFAULT_FORK_PREAMBLE;
	const wrappedPrefix = `${effectivePreamble}\n\nTask:\n`;
	if (task.startsWith(wrappedPrefix)) return task;
	return `${wrappedPrefix}${task}`;
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH)
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

function parseSubagentDepth(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return 0;
	const depth = Number(value);
	return Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

export function checkSubagentDepth(configMaxDepth?: number): { blocked: boolean; depth: number; maxDepth: number } {
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const depth = parseSubagentDepth(process.env.PI_SUBAGENT_DEPTH);
	if (depth === undefined) return { blocked: true, depth: maxDepth, maxDepth };
	return { blocked: depth >= maxDepth, depth, maxDepth };
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const childMaxDepth = normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth();
	const parentDepth = parseSubagentDepth(process.env.PI_SUBAGENT_DEPTH);
	const nextDepth = parentDepth === undefined ? childMaxDepth : parentDepth + 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(childMaxDepth),
	};
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateOutput(
	output: string,
	config: Required<MaxOutputConfig>,
	artifactPath?: string,
): TruncationResult {
	const lines = output.split("\n");
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= config.bytes && lines.length <= config.lines) {
		return { text: output, truncated: false };
	}

	let truncatedLines = lines;
	if (lines.length > config.lines) {
		truncatedLines = lines.slice(0, config.lines);
	}

	let result = truncatedLines.join("\n");
	if (Buffer.byteLength(result, "utf-8") > config.bytes) {
		let low = 0;
		let high = result.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		result = result.slice(0, low);
	}

	const keptLines = result.split("\n").length;
	const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
	};
}
