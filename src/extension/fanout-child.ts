import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { createSubagentExecutor, normalizeSubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { interruptAsyncRun } from "../runs/foreground/foreground-control.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV, SUBAGENT_PARENT_CHILD_INDEX_ENV } from "../runs/shared/pi-args.ts";
import { readNestedControlRequests, resolveNestedRouteFromEnv, writeNestedControlResult } from "../runs/shared/nested-events.ts";
import { deliverSubagentIntercomMessageEvent } from "../intercom/result-intercom.ts";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { readStatus } from "../shared/utils.ts";
import { SubagentParams } from "./schemas.ts";
import { loadConfig } from "./config.ts";
import { registerToolResultAdapter } from "./tool-result.ts";
import { renderSubagentResult } from "../tui/render.ts";
import { type Details, type SubagentExecutionResult, type SubagentState } from "../shared/types.ts";
import { finalizedChildUsage, registerParentUsage } from "../runs/shared/parent-usage.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { OWNED_RUN_ENTRY, restoreOwnedRuns } from "../runs/shared/run-records.ts";

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function createChildSafeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function addBounded(set: Set<string>, value: string, max = 1000): void {
	set.add(value);
	while (set.size > max) set.delete(set.values().next().value!);
}

function startNestedControlInboxListener(pi: ExtensionAPI, state: SubagentState): NodeJS.Timeout | undefined {
	let route;
	try {
		route = resolveNestedRouteFromEnv();
	} catch {
		return undefined;
	}
	if (!route) return undefined;
	const seen = new Set<string>();
	const seenFiles = new Set<string>();
	const inFlight = new Set<string>();
	const pendingResults = new Map<string, Parameters<typeof writeNestedControlResult>[1]>();
	const parsedChildIndex = Number(process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV]);
	const localChildIndex = Number.isInteger(parsedChildIndex) && parsedChildIndex >= 0 ? parsedChildIndex : undefined;
	const timer = setInterval(() => {
		try {
			for (const request of readNestedControlRequests(route, seenFiles)) {
				if (seen.has(request.requestId) || inFlight.has(request.requestId)) continue;
				if (request.targetChildIndex !== undefined && request.targetChildIndex !== localChildIndex) continue;
				const owned = state.ownedRuns?.get(request.targetRunId);
				const asyncJob = state.asyncJobs.get(request.targetRunId);
				if (!owned && !asyncJob && (request.targetChildIndex !== undefined || Date.now() - request.ts < 400)) continue;
				inFlight.add(request.requestId);
				void (async () => {
					const claimPath = `${request.filePath}.claimed`;
					try {
						let result = pendingResults.get(request.requestId);
						if (!result && pendingResults.size >= 100) {
							result = {
								ts: Date.now(),
								requestId: request.requestId,
								targetRunId: request.targetRunId,
								ok: false,
								message: "Nested control result queue is full; retry after pending results are delivered.",
							};
						}
						if (!result) {
							try {
								const claimFd = fs.openSync(claimPath, "wx", 0o600);
								try { fs.writeFileSync(claimFd, `${request.requestId}\n`, "utf-8"); } finally { fs.closeSync(claimFd); }
							} catch (error) {
								const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
								result = {
									ts: Date.now(),
									requestId: request.requestId,
									targetRunId: request.targetRunId,
									ok: false,
									message: code === "EEXIST"
										? "Nested control request was already claimed; refusing to execute it again because the original outcome is unavailable."
										: `Failed to claim nested control request safely: ${error instanceof Error ? error.message : String(error)}`,
								};
							}
						}
						if (!result) {
							let ok = false;
							let message = "Control request failed.";
							try {
								const asyncDir = state.ownedRuns?.get(request.targetRunId)?.asyncDir ?? state.asyncJobs.get(request.targetRunId)?.asyncDir;
								const status = asyncDir ? readStatus(asyncDir) : null;
								if (!status || status.state !== "running") {
									message = `Nested run ${request.targetRunId} is not active in this fanout child.`;
								} else if (request.action === "interrupt") {
									const receipt = interruptAsyncRun(state, request.targetRunId, request.index);
									ok = Boolean(receipt && !receipt.isError);
									message = receipt?.content.map((part) => part.type === "text" ? part.text : "").join("\n") ?? "Nested run is not interruptible.";
								} else if (!request.message?.trim()) {
									message = "Nested resume requires message.";
								} else {
									const index = request.index ?? status.steps?.findIndex((step) => step.status === "running") ?? -1;
									const step = status.steps?.[index];
									const agent = step?.status === "running" ? step.agent : undefined;
									if (!agent) {
										message = `Nested run ${request.targetRunId} has no active child message route.`;
									} else {
										const target = resolveSubagentIntercomTarget(request.targetRunId, agent, index);
										ok = await deliverSubagentIntercomMessageEvent(
											pi.events,
											target,
											`Follow-up for nested run ${request.targetRunId} (${agent}):\n\n${request.message.trim()}`,
											500,
											{ source: "nested-resume", runId: request.targetRunId, agent, index },
										);
										message = ok
											? `Delivered follow-up to live nested run ${request.targetRunId}.`
											: `Nested child intercom target is not registered: ${target}`;
									}
								}
							} catch (error) {
								message = error instanceof Error ? error.message : String(error);
							}
							result = { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok, message };
						}
						try {
							writeNestedControlResult(route, result);
						} catch (error) {
							if (pendingResults.size < 100 || pendingResults.has(request.requestId)) pendingResults.set(request.requestId, result);
							console.error(`Failed to write nested control result for request '${request.requestId}' targeting '${request.targetRunId}' via inbox '${route.controlInbox}'; keeping request for retry:`, error);
							return;
						}
						pendingResults.delete(request.requestId);
						addBounded(seen, request.requestId);
						addBounded(seenFiles, path.basename(request.filePath));
						let requestRemoved = false;
						try {
							fs.unlinkSync(request.filePath);
							requestRemoved = true;
						} catch (error) {
							const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
							requestRemoved = code === "ENOENT";
						}
						if (requestRemoved) {
							try { fs.unlinkSync(claimPath); } catch {}
						}
					} finally {
						inFlight.delete(request.requestId);
					}
				})();
			}
		} catch (error) {
			console.error(`Failed to poll nested control inbox '${route.controlInbox}' for root '${route.rootRunId}':`, error);
		}
	}, 200);
	timer.unref?.();
	return timer;
}

export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] !== "1" || process.env[SUBAGENT_FANOUT_CHILD_ENV] !== "1") return;

	const globalStore = globalThis as Record<string, unknown>;
	const registeredKey = "__piSubagentFanoutChildRegisteredApis";
	const registeredApis = globalStore[registeredKey] instanceof WeakSet
		? globalStore[registeredKey] as WeakSet<ExtensionAPI>
		: new WeakSet<ExtensionAPI>();
	globalStore[registeredKey] = registeredApis;
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const controlInboxCleanupStoreKey = "__piSubagentFanoutChildControlInboxCleanup";
	const previousControlInboxCleanup = globalStore[controlInboxCleanupStoreKey];
	if (typeof previousControlInboxCleanup === "function") {
		try {
			previousControlInboxCleanup();
		} catch {
			// Best effort cleanup for stale timers from an older reload.
		}
	}

	const config = loadConfig();
	const state = createChildSafeState();
	state.persistOwnedRun = (run) => pi.appendEntry(OWNED_RUN_ENTRY, run);
	const ensureSessionState = (ctx: ExtensionContext) => {
		const sessionId = resolveCurrentSessionId(ctx.sessionManager);
		if (state.currentSessionId === sessionId) return;
		state.foregroundRuns?.clear();
		restoreOwnedRuns(state, ctx);
		state.currentSessionId = sessionId;
	};
	pi.on("session_start", (_event, ctx) => ensureSessionState(ctx));
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		// Keep the stock nested default foreground so evidence returns before this caller exits.
		asyncByDefault: config.asyncByDefault === true,
		tempArtifactsDir: getArtifactsDir(null),
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		allowMutatingManagementActions: false,
		ensureSessionState,
	});

	const parentUsage = registerParentUsage(pi, ["subagent"]);
	const adaptToolResult = registerToolResultAdapter(pi, ["subagent"]);
	const toRegisteredToolResult = (result: SubagentExecutionResult, ctx: ExtensionContext) => adaptToolResult(
		result.details.wait?.status === "completed" && result.details.run?.ownerSessionId === ctx.sessionManager.getSessionId()
			? parentUsage.attach(result, finalizedChildUsage(result.details.run.children, result.details.wait.index), ctx)
			: result,
	);
	const nativeAsyncLifecycle = {
		async: true,
		resume: async (id: string, _params: unknown, signal: AbortSignal | undefined,
			onUpdate: ((result: SubagentExecutionResult) => void) | undefined, ctx: ExtensionContext) => {
			const result = await executor.resume(id, {}, signal, onUpdate, ctx);
			return result && toRegisteredToolResult(result, ctx);
		},
	};
	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		...nativeAsyncLifecycle,
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate to subagents from child-safe fanout mode.",
			"For goal-style requests such as /goal, goal, active goal, or work until evidence says done, use explicit acceptance on the delegated run: criteria for the target, evidence/verify for proof, stopRules for constraints, and maxFinalizationTurns for the bounded loop.",
			"For implementation handoffs from a plan, PRD, spec, issue, or broad fix, put implementation instructions and plan paths in task, and put the definition of done, evidence, verification commands, constraints, and loop cap in acceptance.",
			"Allowed management/control actions: list, get, status, nudge, interrupt, extend, resume, questions, answer, review, doctor. Exact status is concise; full:true includes the full task/configuration. Review notes are parent-only, not sent to children. Put actionable instructions in resume/nudge. Resume/answer overrides do not amend live acceptance.",
			"Agent config mutation actions create, update, and delete are blocked in this mode.",
		].join("\n"),
		promptSnippet: "Delegate nested child-safe subagent work from an explicitly allowed fanout child.",
		promptGuidelines: [
			"Delegate useful helper work within your assigned task when it saves time or improves quality; the original parent owns integration and final delivery.",
			"Nested execution defaults to foreground unless configuration explicitly opts into async. Set async:false whenever the nested result must appear in this child's report; use async:true only for intentionally detached work.",
			"Use subagent action:list before nested execution unless the executable nested agent is already known from the task context.",
			"Do not use subagent child-safe mode for agent config mutation actions; create, update, and delete are blocked here.",
		],
		parameters: SubagentParams,
		async execute(id, params, signal, onUpdate, ctx) {
			return toRegisteredToolResult(await executor.execute(id, normalizeSubagentParamsLike(params), signal, onUpdate, ctx), ctx);
		},
		renderResult: renderSubagentResult,
	};

	pi.registerTool(tool);

	const controlInboxTimer = startNestedControlInboxListener(pi, state);
	const clearControlInboxTimer = (): void => {
		if (controlInboxTimer) clearInterval(controlInboxTimer);
	};
	globalStore[controlInboxCleanupStoreKey] = clearControlInboxTimer;

	pi.on("session_shutdown", () => {
		clearControlInboxTimer();
		if (globalStore[controlInboxCleanupStoreKey] === clearControlInboxTimer) {
			delete globalStore[controlInboxCleanupStoreKey];
		}
	});
}
