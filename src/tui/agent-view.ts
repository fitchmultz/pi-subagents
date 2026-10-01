import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, DynamicBorder, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition, createReadToolDefinition, createWriteToolDefinition, getMarkdownTheme, getSelectListTheme, keyText, rawKeyHint, renderDiff, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, CURSOR_MARKER, Editor, Input, MouseRegion, ScrollView, SelectList, Spacer, Text, getKeybindings, matchesKey, truncateToWidth, visibleWidth, type Component, type Keybinding, type OverlayOptions, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { loadConfig as loadIntercomConfig } from "../pi-intercom/config.ts";
import { sendLiveSubagentMessage } from "../intercom/live-intercom.ts";
import { ownedRunView } from "../runs/shared/run-records.ts";
import { listOwnedRunQuestions, questionProcessAlive, type SupervisorQuestionView } from "../runs/shared/supervisor-questions.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-params.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { formatModelThinking } from "../shared/formatters.ts";
import { isTuiContext } from "../shared/ui-mode.ts";
import { acceptanceHumanAction } from "../runs/shared/acceptance.ts";
import { stripAcceptanceReport } from "../runs/shared/acceptance-reports.ts";
import { formatAgentProcessExit } from "../shared/status-format.ts";
import { WIDGET_KEY, type OwnedRun, type OwnedRunView, type SubagentExecutionResult, type SubagentState } from "../shared/types.ts";
import { buildWidgetLines } from "./render.ts";
import { indexedHistory, readableText, withFinalResult, type AgentHistory, type AgentHistoryItem } from "./agent-history.ts";
import { runHistoryIndex } from "../runs/shared/history-index.ts";
import type { HistoryPage, HistoryPageInput, HistoryRunPage, HistoryRunRow } from "../history/index.ts";
import { actionHints, withMouseExpansion } from "./action-hints.ts";

const VIEW_ENTRY = "subagent-view";
const DIRECTION_MESSAGE = "subagent-human-direction";
const UNAVAILABLE_ASSIGNMENT = "Assignment identity unavailable. Your draft is kept; no message or Stop was sent. Inspect the run and choose a verified assignment before sending it.";
const PENDING_MESSAGE_NOTICE = "This message is already waiting for the child. You can keep working or write a different message.";
const CONTINUE_HINT = "Continue with this message (Alt+C)";
const CONTINUE_NOTICES = {
	finished: "This agent has finished. Your draft is kept. Choose ",
	blocked: "This agent needs your action; acceptance is incomplete. Your draft is kept. Choose ",
};
type ExecuteControl = (params: SubagentParamsLike, ctx: ExtensionContext) => Promise<SubagentExecutionResult>;
type Quote = { title: string; text: string };
type Anchor = { id: string; line: number };
interface OutgoingMessage {
	id: string;
	runId: string;
	index: number;
	text: string;
	draft: string;
	quote?: Quote;
	at: number;
	status: "sending" | "waiting" | "unconfirmed";
	reason?: string;
}
export interface AgentVisit {
	draft: string;
	quote?: Quote;
	anchor?: Anchor;
	/** null records a visit before the first saved history entry. */
	readThrough?: string | null;
	seenActivityAt?: number;
	outbox: OutgoingMessage[];
	lastSentId?: string;
	notice?: string | { continue: keyof typeof CONTINUE_NOTICES };
}
export interface AgentTask {
	key: string;
	label: string;
	run: OwnedRunView;
	child: HistoryRunRow["children"][number];
	model: { summary: string; details: string };
	question?: SupervisorQuestionView;
	history: AgentHistoryItem[];
	historyIds: string[];
	finalId?: string;
	unavailable?: string;
	unread: boolean;
	replied: boolean;
	page?: HistoryPage;
	historyLoading?: boolean;
}

const short = (text: string, width = 48) => truncateToWidth(readableText(text).replace(/\s+/g, " ").trim(), width);
const resultText = (result: SubagentExecutionResult) => result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
function primaryKey(action: Keybinding): string {
	const key = getKeybindings().getKeys(action)[0];
	return ({ enter: "Enter", escape: "Esc", up: "↑", down: "↓" } as Record<string, string>)[key ?? ""] ?? readableText(rawKeyHint(key ?? "", "")).trim();
}
export function agentTaskLabel(child: OwnedRunView["children"][number]): string {
	return readableText(child.label || child.task?.split("\n").find((line) => line.trim()) || `${child.agent} · assignment unavailable`).replace(/\s+/g, " ").trim();
}
function activity(task: AgentTask): string {
	if (task.child.identityUnavailable) return "assignment unavailable";
	if (task.question) return task.question.state === "answer_pending" ? "answer saved · waiting" : "needs an answer";
	if (task.child.state === "blocked") return "needs your action · acceptance incomplete";
	if (task.child.state !== "live") return task.child.state === "completed" ? "done" : task.child.state;
	const live = task.child.activity;
	if (live?.status === "pending") return "waiting to start";
	return live?.currentTool ? short(`${live.currentTool} ${live.currentToolArgs || live.currentPath || ""}`, 42)
		: live?.streamingText ? short(live.streamingText, 42) : "working";
}

function taskSummary(task: AgentTask): { status: string; badge: string } {
	let status: string;
	if (task.child.identityUnavailable) status = "unavailable";
	else if (task.question) status = task.question.state === "answer_pending" ? "answer pending" : "needs answer";
	else if (task.child.state === "blocked") status = "needs action";
	else if (task.child.state === "live") status = task.child.activity?.status === "pending" ? "queued" : "working";
	else status = task.child.state === "completed" ? "done" : task.child.state;
	return { status, badge: task.unread ? task.replied ? " · replied" : " · new" : "" };
}

const unavailableModel = { summary: "model unavailable", details: "Model unavailable. No provider/model was recorded for this assignment." };

function agentModel(child: AgentTask["child"], native?: AgentHistory["configuration"]): AgentTask["model"] {
	if (child.identityUnavailable) return unavailableModel;
	const live = child.state === "live", selected = child.modelSelection;
	// A continuation shares its file with the finished run; only the latter's frozen snapshot belongs to it.
	const recorded = live ? native : native?.model ? { ...(child.savedConfiguration ?? child.launch), ...native } : child.savedConfiguration ?? child.launch;
	const current = selected?.modelStartedAt !== undefined && (recorded?.modelRecordedAt ?? 0) > selected.modelStartedAt;
	let source = "selected", value: { model?: string; thinking?: string } | undefined = selected;
	if (recorded?.model && (current || !live && selected?.modelStartedAt === undefined)) {
		value = recorded; source = live ? "session" : "saved";
	} else if (!value?.model) {
		value = live && native?.model ? native : child.launch?.model ? child.launch : child.result;
		source = "saved";
	}
	if (!value?.model) return unavailableModel;
	const formatted = readableText(formatModelThinking(value.model, value.thinking));
	const selectedText = selected?.model && readableText(formatModelThinking(selected.model, selected.thinking));
	const nativeText = native?.model && readableText(formatModelThinking(native.model, native.thinking));
	const details = [`Model (${source}): ${formatted}`];
	if (selectedText && selectedText !== formatted) details.push(`Selected model: ${selectedText}`);
	if (live && nativeText && nativeText !== formatted) details.push(`Last saved session model (may precede this attempt): ${nativeText}`);
	return { summary: source === "session" ? formatted : `${source}: ${formatted}`, details: details.join("\n") };
}

function runningIndicator(theme: Theme): string {
	// Six seconds, sampled by the existing 500 ms refresh; typing cannot speed up the pulse.
	const phase = Math.floor(Date.now() / 500) % 12;
	const ansi = theme.getFgAnsi("success");
	const rgb = theme.getColorMode() === "truecolor" && /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(ansi);
	if (!rgb) return theme.fg("success", phase < 6 ? theme.bold("●") : "●");
	const brightness = 0.9 + 0.1 * Math.cos(phase * Math.PI / 6);
	return theme.fg("success", "●").replace(ansi, `\x1b[38;2;${rgb.slice(1).map((value) => Math.round(Number(value) * brightness)).join(";")}m`);
}

/** One UI controller over the existing owned runs, session files, and executor. */
export class AgentViewController {
	private ctx?: ExtensionContext;
	private ownerSessionId?: string;
	private generation = 0;
	private pending = new AbortController();
	private timer?: ReturnType<typeof setInterval>;
	private saveTimer?: ReturnType<typeof setTimeout>;
	private unsubscribe?: () => void;
	private indexUnsubscribe?: () => void;
	private refreshPromise?: Promise<void>;
	private listRequest = 0;
	private appliedListRequest = -1;
	private filter = "";
	private offset = 0;
	private selectedKey?: string;
	private dockTasks: AgentTask[] = [];
	listPage?: HistoryRunPage;
	listLoading = false;
	listError?: string;
	private taskKeys = new Map<string, string>();
	private visits = new Map<string, AgentVisit>();
	private busy = new Set<string>();
	private lastSaved = "";
	private render?: () => void;
	private closeOverlay?: (next?: string) => void;
	private widget?: Component;
	readonly shortcut = loadIntercomConfig().shortcut;
	private overlay?: AgentConversation | AgentPicker;
	tasks: AgentTask[] = [];
	pinned?: string;

	private pi: ExtensionAPI;
	private state: SubagentState;
	private execute: ExecuteControl;

	constructor(pi: ExtensionAPI, state: SubagentState, execute: ExecuteControl) {
		this.pi = pi; this.state = state; this.execute = execute;
		pi.registerCommand("agents", { description: "View, message, answer, stop, or continue your agents", handler: async (_args, ctx) => this.open(undefined, ctx) });
		pi.registerMessageRenderer(DIRECTION_MESSAGE, withMouseExpansion((message, options, theme) => {
			const details = message.details as { label: string; text: string; quote?: Quote };
			return {
				render(width) {
					const key = keyText("app.tools.expand");
					return new Text(options.expanded ? `User → ${details.label}\n${details.text}${details.quote ? `\n\nReplying to ${details.quote.title}:\n${details.quote.text}` : ""}`
						: theme.fg("dim", `User → ${details.label}: ${short(details.text, 100)} · sent directly${key ? ` · ${key}` : ""}`), 0, 0).render(width);
				},
				invalidate() {},
			};
		}));
	}

	start(ctx: ExtensionContext): void {
		this.dispose();
		if (!isTuiContext(ctx)) return;
		this.ctx = ctx;
		this.pending = new AbortController();
		const ownerSessionId = ctx.sessionManager.getSessionId();
		this.ownerSessionId = ownerSessionId;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== VIEW_ENTRY) continue;
			const saved = entry.data as { ownerSessionId?: string; visits?: Array<[string, AgentVisit]>; pinned?: string };
			if (saved?.ownerSessionId === ownerSessionId && Array.isArray(saved.visits)) {
				this.visits = new Map(saved.visits);
				this.pinned = saved.pinned;
			}
		}
		for (const visit of this.visits.values()) for (const sent of visit.outbox) if (sent.status === "sending") sent.status = "unconfirmed";
		this.unsubscribe = this.pi.events.on("subagent:open-agents", (data) => {
			const request = data as { ctx?: ExtensionContext; handled?: boolean };
			if (!this.live() || request.ctx?.sessionManager.getSessionId() !== ownerSessionId) return;
			request.handled = true;
			void this.open();
		});
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			this.render = () => tui.requestRender();
			let hits: Array<{ start: number; end: number; key?: string; unpin?: boolean; row: number }> = [];
			const widget = new MouseRegion({
				invalidate() {},
				render: (width) => {
					hits = [];
					const active = this.dockTasks.filter((task) => task.child.state === "live" || task.child.state === "blocked" || task.question)
						.map((task) => ({ task, state: task.child.state === "blocked" || task.question?.state === "awaiting_input" ? "needs action" : task.child.activity?.status === "pending" || task.question?.state === "answer_pending" ? "waiting" : "running" }));
					if (!active.length) {
						if (!this.listError && !this.listLoading && this.listPage?.freshness.state !== "catching-up") return [];
						const label = this.listError ? "Agents history unavailable · /agents to retry" : "Agents · loading history…";
						hits.push({ start: 0, end: width, row: 0 });
						return [truncateToWidth(theme.fg(this.listError ? "warning" : "dim", label), width)];
					}
					const running = active.filter((row) => row.state === "running").length;
					const waiting = active.filter((row) => row.state === "waiting").length;
					const needsAction = active.filter((row) => row.state === "needs action").length;
					const counts = `${running} running${waiting ? ` · ${waiting} waiting` : ""}${needsAction ? ` · ${needsAction} needs action` : ""}`;
					const hint = readableText(rawKeyHint(this.shortcut, "")).trim();
					const entrance = `${theme.fg("accent", theme.bold("Agents"))} · ${theme.fg(running ? "success" : "muted", counts)} ${theme.fg("dim", `[${hint}]`)}`;
					const lines = [truncateToWidth(entrance, width)];
					hits.push({ start: 0, end: Math.min(width, visibleWidth(entrance)), row: 0 });
					const visible = active.slice(0, Math.max(1, Math.min(4, Math.floor(tui.terminal.rows / 5))));
					const pinned = this.tasks.find((task) => task.key === this.pinned);
					const details = ctx.ui.getToolsExpanded() ? buildWidgetLines([...this.state.asyncJobs.values()], theme, width, true) : [];
					// MainScreen repaints all scrollback if an offscreen row's ANSI changes.
					const pulseFrom = tui.mode === "regular" ? visible.length + details.length + Number(Boolean(pinned)) + Number(visible.length < active.length)
						+ (this.componentsBelowWidget(tui) ?? []).reduce((height, child) => height + child.render(width).length, 0) - tui.terminal.rows : 0;
					for (const [index, { task, state }] of visible.entries()) {
						const color = state === "running" ? "success" : state === "waiting" ? "dim" : "warning";
						const symbol = state === "running" ? "●" : state === "waiting" ? "◷" : "!";
						const indicator = state === "running" && index >= pulseFrom ? runningIndicator(theme) : theme.fg(color, symbol);
						const { status, badge } = taskSummary(task);
						const statusText = status === "working" ? "" : theme.fg(color, ` · ${status}`);
						const available = width - visibleWidth(statusText + badge) - 4;
						const modelWidth = available - Math.min(30, visibleWidth(task.label)) - 3;
						const model = modelWidth >= 16 ? ` · ${short(task.model.summary, modelWidth)}` : "";
						const label = short(task.label, Math.max(1, available - visibleWidth(model)));
						hits.push({ start: 0, end: width, row: lines.length, key: task.key });
						lines.push(truncateToWidth(`  ${indicator} ${theme.bold(label)}${statusText}${theme.fg("accent", badge)}${theme.fg("dim", model)}`, width));
					}
					if (visible.length < active.length) {
						const more = `  +${active.length - visible.length} more · /agents`, line = truncateToWidth(more, width, "...");
						hits.push({ start: 2, end: visibleWidth(line) - (visibleWidth(more) > width ? 3 : 0), row: lines.length });
						lines.push(theme.fg("dim", line));
					}
					if (pinned) {
						const preview = pinned.child.identityUnavailable ? UNAVAILABLE_ASSIGNMENT : pinned.child.state === "live" ? activity(pinned) : (pinned.child.result && getSingleResultOutput(pinned.child.result)) || pinned.history.findLast((item) => item.kind === "assistant")?.text || activity(pinned);
						const unpin = "[Unpin] ", row = lines.length;
						lines.push(theme.fg("dim", truncateToWidth(`${unpin}Pinned · ${pinned.child.state === "completed" ? "finished · " : ""}${short(pinned.label, 30)}: ${short(preview, width)}`, width)));
						hits.push({ start: 0, end: unpin.length, row, unpin: true }, { start: unpin.length, end: width, row, key: pinned.key });
					}
					lines.push(...details);
					return lines;
				},
			}, (event) => {
				if (tui.mode !== "fullscreen" || event.button !== "left" || !this.live()) return;
				const hit = hits.find((hit) => hit.row === event.y && event.x >= hit.start && event.x < hit.end);
				if (!hit) return;
				if (event.type === "press") return { handled: true };
				if (event.type !== "click") return;
				if (hit.unpin) this.pin(undefined); else void this.open(hit.key);
				return { handled: true };
			});
			this.widget = widget;
			return widget;
		});
		void this.refresh();
		this.timer = setInterval(() => { this.render?.(); if (!this.listError) void this.refresh(); }, 500);
		this.timer.unref?.();
	}

	private live(generation = this.generation): boolean {
		return generation === this.generation && Boolean(this.ctx && this.ctx.sessionManager.getSessionId() === this.ownerSessionId
			&& this.state.lastUiContext?.sessionManager.getSessionId() === this.ownerSessionId);
	}

	visit(key: string): AgentVisit {
		let visit = this.visits.get(key);
		if (!visit) { visit = { draft: "", outbox: [] }; this.visits.set(key, visit); }
		return visit;
	}

	private taskKey(run: OwnedRun, child: Pick<OwnedRunView["children"][number], "index" | "workflowNodeId" | "sessionFile" | "identityUnavailable">): string {
		const path = new Set<string>();
		let key: string;
		for (;;) {
			const cacheKey = `${run.runId}:${child.workflowNodeId ?? (run.mode === "chain" ? child.sessionFile ?? child.index : child.index)}`, cached = this.taskKeys.get(cacheKey);
			if (cached) { key = cached; break; }
			if (path.has(cacheKey)) throw new Error("Cyclic saved continuation ancestry");
			path.add(cacheKey);
			const predecessor = run.predecessorRunId && this.state.ownedRuns?.get(run.predecessorRunId);
			if (!predecessor) {
				key = `${run.runId}:${child.workflowNodeId ?? (run.mode === "chain" && child.sessionFile && !child.identityUnavailable ? `session:${child.sessionFile}` : child.index)}`;
				break;
			}
			const index = run.predecessorIndex ?? 0;
			child = predecessor.children.find((candidate) => candidate.index === index) ?? { index };
			run = predecessor;
		}
		for (const cacheKey of path) this.taskKeys.set(cacheKey, key);
		return key;
	}

	private fromView(view: HistoryRunRow, questions = view.questions ?? [], canonical = false): AgentTask[] {
		return view.children.filter((child) => !view.matchedChildIndexes || view.matchedChildIndexes.includes(child.index)).map((child) => {
			const key = this.taskKey(view, child), prior = this.task(key) ?? this.dockTasks.find((task) => task.key === key), visit = this.visits.get(key);
			const sameAttempt = prior?.run.runId === view.runId;
			const selected = !canonical && this.selectedKey === key && sameAttempt;
			const displayChild = selected ? { ...child, task: prior.child.task, launch: prior.child.launch, result: child.result && prior.run.updatedAt === view.updatedAt ? prior.child.result : child.result,
				activity: { ...prior.child.activity, ...child.activity } } : child;
			return { key, label: child.identityUnavailable ? "Saved assignment unavailable" : sameAttempt ? agentTaskLabel(child) : prior?.label ?? agentTaskLabel(child), run: view, child: displayChild,
				model: agentModel(displayChild, child.nativeConfiguration ?? (canonical && sameAttempt && child.sessionFile === prior.child.sessionFile ? prior.page?.configuration : undefined)), history: sameAttempt ? prior.history : [], historyIds: sameAttempt ? prior.historyIds : [],
				page: sameAttempt ? prior.page : undefined, historyLoading: sameAttempt ? prior.historyLoading : false, finalId: sameAttempt ? prior.finalId : undefined, unavailable: child.missingSession && child.state !== "live" ? "Saved conversation unavailable." : view.diagnosis,
				question: child.identityUnavailable ? undefined : questions.findLast((question) => question.index === child.index && ["awaiting_input", "answer_pending"].includes(question.state)),
				unread: Boolean(visit && (child.activity?.lastActivityAt ?? view.updatedAt) > (visit.seenActivityAt ?? 0)), replied: sameAttempt ? prior.replied : false };
		});
	}

	private unavailableTask(key: string, run: OwnedRunView): AgentTask {
		return { key, label: "Saved assignment unavailable", run,
			child: { agent: "unknown", index: -1, state: "unknown", configuration: "legacy-partial", identityUnavailable: true },
			model: unavailableModel, history: [], historyIds: [], unavailable: UNAVAILABLE_ASSIGNMENT, unread: false, replied: false };
	}

	/** SQLite is browse-only. Recheck just this root lineage before any control. */
	private refreshSelected(key: string): void {
		const current = this.task(key), root = current?.run.rootRunId ?? this.state.ownedRuns?.get(key.split(":")[0]!)?.rootRunId;
		if (!root || !this.live()) return;
		this.taskKeys.clear();
		let selected: AgentTask | undefined, rootView: OwnedRunView | undefined;
		try {
			for (const run of this.state.ownedRuns?.values() ?? []) {
				if (run.rootRunId !== root || run.ownerSessionId !== this.ownerSessionId) continue;
				const questions = listOwnedRunQuestions(run.ownerSessionId, run.runId);
				const view = ownedRunView(run, this.state, { pendingInput: questions.some((question) => ["awaiting_input", "answer_pending"].includes(question.state)), includeContinuations: false, readConfiguration: false });
				if (view.runId === key.split(":")[0]) rootView = view;
				const candidate = this.fromView(view, questions, true).find((task) => task.key === key);
				if (candidate && (!selected || selected.run.startedAt <= candidate.run.startedAt)) selected = candidate;
			}
		} catch (error) {
			if (current) selected = { ...current, child: { ...current.child, state: "unknown", identityUnavailable: true }, question: undefined,
				unavailable: `Run authority unavailable: ${String(error)}` };
		}
		if (!selected && current) selected = { ...current, child: { ...current.child, state: "unknown", identityUnavailable: true }, question: undefined, unavailable: UNAVAILABLE_ASSIGNMENT };
		if (!selected && rootView && this.visits.has(key)) selected = this.unavailableTask(key, rootView);
		if (selected) {
			const position = this.tasks.findIndex((task) => task.key === key);
			if (position < 0) this.tasks.push(selected);
			else this.tasks[position] = selected;
			this.dockTasks = this.dockTasks.map((task) => task.key === key ? selected! : task);
		}
		this.overlay?.refresh(); this.render?.();
	}

	/** Bounded asynchronous observations; no owner files or native bodies on this path. */
	refresh(browse = false): Promise<void> {
		if (!this.live()) return Promise.resolve();
		if (!browse && !this.state.ownedRuns?.size && !this.state.historyIndex) return Promise.resolve();
		if (this.refreshPromise) return this.refreshPromise;
		const generation = this.generation, request = this.listRequest, offset = this.offset, text = this.filter;
		this.listLoading = this.listPending;
		this.refreshPromise = (async () => {
			try {
				const index = await runHistoryIndex(this.state);
				if (!this.live(generation)) return;
				this.indexUnsubscribe ??= index.onChanged(() => { void this.refresh(); });
				const page = await index.listRuns({ offset, limit: 50, text: text || undefined, sort: "attention", latestTasksOnly: true });
				const dock = text || offset ? await index.listRuns({ limit: 50, sort: "attention", latestTasksOnly: true }) : page;
				if (!this.live(generation) || request !== this.listRequest) return;
				this.listPage = page; this.appliedListRequest = request; this.listError = undefined;
				const tasks = new Map<string, AgentTask>();
				for (const row of page.rows) for (const task of this.fromView(row)) {
					const prior = tasks.get(task.key);
					if (!prior || prior.run.startedAt <= task.run.startedAt) tasks.set(task.key, task);
				}
				for (const [key, visit] of this.visits) {
					if (tasks.has(key) || !visit.draft && !visit.quote && !visit.outbox.length && this.pinned !== key) continue;
					const row = page.rows.find((run) => run.runId === key.split(":")[0]);
					if (row) tasks.set(key, this.unavailableTask(key, row));
				}
				// Keep only the open conversation/pin, not every historical terminal view.
				for (const key of [this.selectedKey, this.pinned]) {
					const retained = key && this.task(key);
					if (retained && !tasks.has(key!)) tasks.set(key!, retained);
				}
				this.tasks = [...tasks.values()];
				this.dockTasks = dock.rows.flatMap((row) => this.fromView(row));
				const markers = new Map([...this.tasks, ...this.dockTasks].map((task) => [task.key, task]));
				for (const task of markers.values()) {
					const visit = this.visits.get(task.key);
					if (!visit || task.child.identityUnavailable) continue;
					try {
						const facts = await index.historyPage({ ...this.historyInput(task), limit: 1 });
						if (!this.live(generation) || request !== this.listRequest) return;
						for (const observed of [...this.tasks, ...this.dockTasks].filter((candidate) => candidate.key === task.key)) this.applyMetadata(observed, facts);
					} catch (error) {
						if (!this.live(generation) || request !== this.listRequest) return;
						task.unavailable = `Conversation metadata unavailable: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
			} catch (error) {
				if (this.live(generation) && request === this.listRequest) this.listError = `Agents history unavailable: ${error instanceof Error ? error.message : String(error)}. Retry (F5).`;
			} finally {
				if (this.live(generation)) {
					this.listLoading = false; this.refreshPromise = undefined;
					this.overlay?.refresh(); this.render?.();
					if (request !== this.listRequest) void this.refresh();
				}
			}
		})();
		return this.refreshPromise;
	}

	get listFilter(): string { return this.filter; }
	get listPending(): boolean { return !this.listPage || this.appliedListRequest !== this.listRequest; }

	filterTasks(text: string): void {
		if (text === this.filter) return;
		this.filter = text.slice(0, 256); this.offset = 0; this.listRequest++; this.tasks = this.tasks.filter((task) => task.key === this.selectedKey || task.key === this.pinned);
		void this.refresh();
	}

	pageTasks(direction: "earlier" | "later"): void {
		const next = direction === "later" ? this.listPage?.nextOffset : Math.max(0, this.offset - 50);
		if (next === undefined || next === this.offset) return;
		this.offset = next; this.listRequest++; void this.refresh();
	}

	async retry(key?: string): Promise<void> {
		const generation = this.generation;
		try { const index = await runHistoryIndex(this.state); await index.refresh(key ? this.task(key)?.run.runId : undefined); }
		catch (error) { if (this.live(generation)) this.listError = `History refresh unavailable: ${String(error)}`; }
		if (this.live(generation)) await this.refresh();
	}

	async historyPage(key: string, paging: Pick<HistoryPageInput, "before" | "after" | "cursor"> = {}, anchor?: string | null): Promise<{ history: AgentHistory; page: HistoryPage; latestPage: boolean; readThroughSequence?: number } | undefined> {
		const task = this.task(key), generation = this.generation;
		if (!task || !this.live() || task.child.identityUnavailable) return;
		const input = this.historyInput(task), index = await runHistoryIndex(this.state);
		const boundary = { runId: task.run.runId, index: task.child.index, terminalEntryId: input.terminalEntryId, endedAt: input.endedAt };
		const marker = typeof input.readThrough === "string" && !input.readThrough.startsWith("result:")
			? await index.entry({ ...boundary, entryId: input.readThrough.replace(/:(?:\d+|error)$/, "") }) : undefined;
		if (anchor === null) paging = { after: 0 };
		else if (anchor && !anchor.startsWith("result:")) {
			const entry = anchor === input.readThrough ? marker : await index.entry({ ...boundary, entryId: anchor.replace(/:(?:\d+|error)$/, "") });
			if (entry) paging = { after: Math.max(0, entry.sequence - 1) };
		}
		const result = await indexedHistory(index, { ...input, limit: 100, ...paging });
		if (!this.live(generation) || this.task(key)?.run.runId !== task.run.runId) return;
		return { ...result, latestPage: paging.after !== undefined ? !result.page.hasMore : paging.before === undefined && paging.cursor === undefined,
			readThroughSequence: marker?.sequence ?? (input.readThrough == null ? -1 : undefined) };
	}

	async savedResult(key: string, id: string): Promise<AgentHistoryItem> {
		const task = this.task(key), generation = this.generation;
		if (!task || !this.live()) throw new Error("The owning session is no longer available.");
		const index = await runHistoryIndex(this.state);
		const result = await index.result({ runId: task.run.runId, index: task.child.index });
		if (!this.live(generation) || this.task(key)?.run.runId !== task.run.runId) throw new Error("The selected attempt changed; choose the report again.");
		if (!result) throw new Error("The selected saved report is unavailable.");
		return { id, kind: "assistant", title: "Saved result", text: readableText(result.text), timestamp: result.timestamp };
	}

	private historyInput(task: AgentTask): HistoryPageInput {
		const visit = this.visits.get(task.key);
		return { runId: task.run.runId, index: task.child.index,
			messageIds: [...new Set([...(visit?.outbox.slice(0, 999).map((sent) => sent.id) ?? []), ...(visit?.lastSentId ? [visit.lastSentId] : [])])], readThrough: visit?.readThrough,
			...(task.child.state === "live" ? {} : { leaf: task.child.result?.terminalLeafId, terminalEntryId: task.child.result?.terminalEntryId, endedAt: task.child.result?.terminalEntryId ? undefined : task.run.updatedAt }) };
	}

	applyMetadata(task: AgentTask, page: HistoryPage): void {
		const visit = this.visits.get(task.key), delivered = new Map(page.deliveredMessages);
		task.model = agentModel(task.child, page.configuration);
		task.unread = Boolean(page.unreadAfter || visit && (task.child.activity?.lastActivityAt ?? 0) > (visit.seenActivityAt ?? 0));
		task.replied = Boolean(visit?.lastSentId && delivered.get(visit.lastSentId));
		if (!visit) return;
		if (visit.lastSentId && delivered.has(visit.lastSentId) && visit.notice === PENDING_MESSAGE_NOTICE) visit.notice = undefined;
		for (const sent of visit.outbox) {
			if (!delivered.has(sent.id)) continue;
			if (visit.draft === sent.draft) { visit.draft = ""; visit.quote = undefined; if (this.selectedKey === task.key) this.overlay?.syncDraft(); }
		}
		visit.outbox = visit.outbox.filter((sent) => !delivered.has(sent.id));
	}

	task(key: string): AgentTask | undefined { return this.tasks.find((task) => task.key === key); }
	isBusy(key: string): boolean { return this.busy.has(key); }

	changed(): void {
		if (!this.live()) return;
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.save(), 300);
		this.saveTimer.unref?.();
		this.render?.();
	}

	/** Native idle capture flushes the existing debounced view entry, not a new store. */
	prepareCheckpoint(): boolean {
		if (this.busy.size || this.overlay) return false;
		this.save();
		return true;
	}

	private save(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		if (!this.live()) return;
		const saved = { ownerSessionId: this.ctx!.sessionManager.getSessionId(), visits: [...this.visits], pinned: this.pinned };
		const serialized = JSON.stringify(saved);
		if (serialized === this.lastSaved) return;
		this.pi.appendEntry(VIEW_ENTRY, saved);
		this.lastSaved = serialized;
	}

	pin(key: string | undefined): void { this.pinned = key; this.save(); this.render?.(); }

	private componentsBelowWidget(tui: TUI): Component[] | undefined {
		if (!this.widget) return undefined;
		// Public children work across loader boundaries; never render the parent history to measure the dock.
		const parent = tui.children.find((child): child is Component & Pick<Container, "children"> => "children" in child && Array.isArray(child.children) && child.children.includes(this.widget));
		return parent && [...parent.children.slice(parent.children.indexOf(this.widget) + 1), ...tui.children.slice(tui.children.indexOf(parent) + 1)];
	}

	availableHeight(tui: TUI): number {
		if (tui.mode !== "fullscreen" || !this.widget) return Math.max(1, tui.terminal.rows - 2);
		const below = this.componentsBelowWidget(tui);
		if (!below) return Math.max(1, tui.terminal.rows - 2);
		const dock = [this.widget, ...below].reduce((height, child) => height + child.render(tui.terminal.columns).length, 0);
		return Math.max(1, tui.terminal.rows - dock - 1);
	}

	async open(key?: string, ctx = this.ctx): Promise<void> {
		if (!ctx || !isTuiContext(ctx)) return;
		if (!this.ctx || this.ctx.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) this.start(ctx);
		if (!this.live()) return;
		if (this.overlay) {
			this.closeOverlay?.(this.overlay instanceof AgentConversation && this.overlay.key === key ? undefined : key);
			return;
		}
		const generation = this.generation;
		if (!this.listPage) await this.refresh(true);
		if (!this.live(generation)) return;
		let selected = key ?? (!this.filter && this.tasks.length === 1 && this.listPage?.total === 1 ? this.tasks[0]!.key : undefined);
		while (this.live(generation)) {
			this.selectedKey = selected;
			if (selected) this.refreshSelected(selected);
			let height: (() => number) | undefined;
			const overlayOptions: OverlayOptions = { width: "96%", margin: 1, anchor: "center", get maxHeight() { return height?.(); } };
			const result = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
				height = () => this.availableHeight(tui);
				if (tui.mode === "fullscreen") overlayOptions.anchor = "top-center";
				this.closeOverlay = (next) => done(next);
				this.overlay = selected && this.task(selected)
					? new AgentConversation(tui, theme, this, selected, done, keys)
					: new AgentPicker(tui, theme, this, done);
				return this.overlay;
			}, { overlay: true, overlayOptions });
			if (!this.live(generation)) return;
			this.overlay = undefined;
			for (const task of [...this.tasks, ...this.dockTasks]) if (task.key === this.selectedKey) {
				task.history = []; task.historyIds = []; task.page = undefined; task.finalId = undefined; task.historyLoading = false;
			}
			this.selectedKey = undefined;
			this.closeOverlay = undefined;
			this.save();
			void this.refresh();
			if (result === "peers") { this.pi.events.emit("intercom:open", {}); return; }
			if (!result) return;
			selected = result === "picker" ? undefined : result;
		}
	}

	private breadcrumb(task: AgentTask, text: string, quote?: Quote): void {
		const label = short(task.label, 42);
		this.pi.sendMessage({ customType: DIRECTION_MESSAGE, display: true,
			content: `For context only: the user sent this directly to ${label} (run ${task.run.runId}, child ${task.child.index}). No relay or approval is needed.\n\n${text}${quote ? `\n\nRegarding ${quote.title}:\n${quote.text}` : ""}`,
			details: { label, text, quote, runId: task.run.runId, index: task.child.index } }, { triggerTurn: false });
	}

	async send(key: string, text: string, continueExplicitly = false): Promise<void> {
		if (!text.trim() || !this.live() || this.busy.has(key)) return;
		this.refreshSelected(key);
		const task = this.task(key), visit = this.visit(key), generation = this.generation;
		if (!task) return;
		if (task.child.identityUnavailable) { visit.notice = UNAVAILABLE_ASSIGNMENT; this.changed(); return; }
		if (task.child.activity?.status === "pending") return;
		const question = task.question;
		const liveQuestion = question && questionProcessAlive(question);
		if (task.child.state !== "live" && !liveQuestion && !continueExplicitly) {
			visit.notice = { continue: task.child.state === "blocked" ? "blocked" : "finished" };
			this.changed(); return;
		}
		if (!liveQuestion && task.child.state !== "live" && (task.child.missingSession || (!task.child.sessionFile && continueExplicitly))) {
			visit.notice = "The saved conversation is unavailable. No agent was started; your draft is kept.";
			this.changed(); return;
		}
		if (continueExplicitly && task.child.state !== "live" && !task.child.launch) {
			visit.notice = `This older run has no saved profile. Inspect it, then use agent_runs continue with agent: ${JSON.stringify(task.child.agent)} to explicitly choose the current profile. Your draft is kept.`;
			this.changed(); return;
		}
		const draft = visit.draft, quote = visit.quote;
		if (!continueExplicitly && visit.outbox.some((sent) => sent.status !== "unconfirmed" && sent.text === text && JSON.stringify(sent.quote) === JSON.stringify(quote))) {
			visit.notice = PENDING_MESSAGE_NOTICE;
			this.changed(); return;
		}
		const message = `${text}${quote ? `\n\nRegarding ${quote.title}:\n${quote.text}` : ""}`;
		this.busy.add(key);
		visit.notice = undefined;
		this.changed();
		try {
			if (question || task.child.state !== "live") {
				const result = await this.execute({ action: question ? "answer" : "resume", id: task.run.runId, index: task.child.index,
					...(question ? { questionId: question.questionId } : {}), message, messageOrigin: "human" }, this.ctx!);
				if (!this.live(generation)) return;
				visit.notice = result.isError ? resultText(result) : question ? "Answer saved; waiting for the child. This is not proof it has acted." : "Continuation started on the saved conversation.";
				if (!result.isError) {
					if (visit.draft === draft) { visit.draft = ""; visit.quote = undefined; }
					visit.outbox = visit.outbox.filter((sent) => sent.draft !== draft);
					this.breadcrumb(task, text, quote);
				}
			} else {
				const sent: OutgoingMessage = { id: randomUUID(), runId: task.run.runId, index: task.child.index, text, draft, quote, at: Date.now(), status: "sending" };
				visit.outbox.push(sent);
				visit.lastSentId = sent.id;
				this.save();
				const receipt = await sendLiveSubagentMessage(this.pi.events, {
					to: resolveSubagentIntercomTarget(task.run.runId, task.child.agent, task.child.index), message: text, delivery: "steer", timeoutMs: 15_000, signal: this.pending.signal,
					extra: { messageId: sent.id, human: { ownerSessionId: this.ctx!.sessionManager.getSessionId(), runId: task.run.runId, index: task.child.index },
						...(quote ? { attachments: [{ type: "context", name: quote.title, content: quote.text }] } : {}) },
				});
				if (!this.live(generation)) return;
				sent.status = receipt.accepted || receipt.delivered ? "waiting" : "unconfirmed";
				sent.reason = receipt.reason;
				if (receipt.accepted || receipt.delivered) this.breadcrumb(task, text, quote);
				else visit.notice = `Delivery unconfirmed. Your draft is kept. ${receipt.reason ?? "Check the conversation before retrying."}`;
			}
		} catch (error) {
			if (this.live(generation)) visit.notice = `Message not confirmed; draft kept. ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			if (this.live(generation)) { this.busy.delete(key); this.refreshSelected(key); this.overlay?.syncDraft(); this.save(); }
		}
	}

	async stop(key: string): Promise<void> {
		if (!this.live() || this.busy.has(key)) return;
		this.refreshSelected(key);
		const task = this.task(key);
		if (!task || task.child.identityUnavailable || (task.child.state !== "live" && !task.question)) return;
		if (task.child.activity?.status === "pending") return;
		const generation = this.generation;
		this.busy.add(key);
		try {
			const result = await this.execute({ action: "interrupt", id: task.run.runId, index: task.child.index }, this.ctx!);
			if (!this.live(generation)) return;
			this.visit(key).notice = result.isError ? resultText(result) : "Stop requested for this child only. Independent siblings continue; dependent workflow steps may not run.";
		} catch (error) {
			if (this.live(generation)) this.visit(key).notice = `Stop not confirmed: ${error instanceof Error ? error.message : String(error)}`;
		} finally { if (this.live(generation)) { this.busy.delete(key); this.refreshSelected(key); this.changed(); } }
	}

	async changes(key: string): Promise<AgentHistoryItem | undefined> {
		const task = this.task(key), generation = this.generation;
		if (!task || !this.live()) return;
		const cwd = task.child.launch?.cwd ?? task.run.cwd;
		const result = await this.pi.exec("git", ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"], { cwd, timeout: 10_000, signal: this.pending.signal });
		if (!this.live(generation)) return;
		return { id: "working-tree-changes", kind: "change", title: `Working tree changes · ${cwd}`, timestamp: Date.now(),
			text: "This is the working tree, not a claim that this child made every change. Untracked files are not included; inspect write/tool results for their full content.",
			diff: result.code === 0 ? readableText(result.stdout) || "No tracked changes." : undefined,
			details: result.code === 0 ? undefined : readableText(result.stderr) };
	}

	dispose(): void {
		this.save();
		this.generation++;
		this.pending.abort();
		this.closeOverlay?.();
		this.overlay?.dispose();
		this.closeOverlay = undefined;
		this.overlay = undefined;
		this.unsubscribe?.(); this.unsubscribe = undefined;
		this.indexUnsubscribe?.(); this.indexUnsubscribe = undefined;
		this.refreshPromise = undefined; this.listRequest++;
		this.listPage = undefined; this.listError = undefined; this.listLoading = false;
		this.selectedKey = undefined; this.offset = 0; this.filter = "";
		if (this.timer) clearInterval(this.timer);
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.timer = this.saveTimer = undefined;
		this.render = undefined;
		this.widget = undefined;
		this.ctx = undefined;
		this.ownerSessionId = undefined;
		this.tasks = []; this.dockTasks = [];
		this.taskKeys.clear(); this.visits.clear(); this.busy.clear();
		this.pinned = undefined; this.lastSaved = "";
	}
}

class AgentPicker extends Container {
	private list?: SelectList;
	private itemKeys: string[] = [];
	private closed = false;
	private search: Input;
	private signature = "";
	private wasPending = false;
	private hasFocus = false;
	private tui: TUI;
	private theme: Theme;
	private controller: AgentViewController;
	private done: (key?: string) => void;
	constructor(tui: TUI, theme: Theme, controller: AgentViewController, done: (key?: string) => void) {
		super();
		this.tui = tui; this.theme = theme; this.controller = controller; this.done = done;
		this.search = new Input({ placeholder: "Filter agents or assignments…", placeholderStyle: (text) => theme.fg("dim", text) });
		this.search.setValue(controller.listFilter);
		this.render(tui.terminal.columns);
	}
	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.search.focused = value; }
	refresh(): void { this.tui.requestRender(); }
	render(width: number): string[] {
		const height = this.controller.availableHeight(this.tui), innerWidth = Math.max(1, width - 2);
		const query = this.search.getValue();
		const tasks = this.controller.tasks.filter((task) => this.controller.listPage?.rows.some((run) => run.runId === task.run.runId));
		const items = tasks.map((task) => {
			const { status, badge } = taskSummary(task);
			return { value: task.key, label: `${task.child.agent} · ${task.label}`, description: status + badge };
		});
		if (this.controller.listPage?.offset) items.push({ value: "previous-page", label: "Previous agents", description: "PgUp" });
		if (this.controller.listPage?.nextOffset !== undefined) items.push({ value: "next-page", label: "More agents", description: "PgDn" });
		items.push({ value: "retry", label: "Refresh / retry history", description: "F5" });
		if (!query) items.push({ value: "peers", label: "Other connected sessions", description: "All projects" });
		const labelWidth = Math.min(Math.max(0, ...items.map((item) => visibleWidth(item.label))), Math.max(40, Math.floor(innerWidth / 2)));
		for (const [index, task] of tasks.entries()) {
			const item = items[index]!, modelWidth = innerWidth - labelWidth - visibleWidth(item.description) - 7;
			if (modelWidth >= 16) item.description += ` · ${short(task.model.summary, modelWidth)}`;
		}
		this.itemKeys = items.map((item) => item.value);
		const selected = this.controller.listPending || this.wasPending ? undefined : this.list?.getSelectedItem()?.value;
		this.wasPending = this.controller.listPending;
		const selectedIndex = Math.max(0, items.findIndex((item) => item.value === selected));
		const task = this.controller.task(items[selectedIndex]?.value ?? "");
		const status = this.controller.listError ?? (this.controller.listPage?.freshness.state === "catching-up" ? "Catching up · partial results" : this.controller.listPage?.freshness.state === "degraded" ? "Some history unavailable · F5 retry" : this.controller.listLoading ? "Loading…" : "");
		const signature = JSON.stringify([items, query, width, height, status, this.controller.listPage?.total, items[selectedIndex]?.value, task && activity(task), task?.model, task?.child.task, task?.run.runId]);
		if (signature !== this.signature) {
			const compact = height < 16;
			const header = new Container();
			header.addChild(new Text(this.theme.fg("accent", this.theme.bold(truncateToWidth(`Agents · ${this.controller.listPage?.total ?? "…"} owned runs · page ${Math.floor((this.controller.listPage?.offset ?? 0) / 50) + 1}`, innerWidth))), 0, 0));
			header.addChild(this.search);
			if (status) header.addChild(new Text(this.theme.fg(this.controller.listError ? "warning" : "dim", truncateToWidth(status, innerWidth)), 0, 0));
			if (!compact) header.addChild(new Spacer(1));
			const footer = new Container();
			if (!compact) footer.addChild(new Spacer(1));
			if (task && !compact) {
				footer.addChild(new Text(this.theme.fg("muted", short(`${task.child.agent} · ${activity(task)} · ${task.run.runId.slice(0, 8)}`, innerWidth)), 0, 0));
				footer.addChild(new Text(this.theme.fg("dim", short(task.model.summary, innerWidth)), 0, 0));
				const assignment = new Text(readableText(task.child.task ?? "Original assignment unavailable."), 0, 0).render(innerWidth);
				footer.addChild(new Text(assignment.slice(0, 3).join("\n"), 0, 0));
			}
			const up = primaryKey("tui.select.up"), down = primaryKey("tui.select.down");
			const choose = [{ text: up, run: () => this.act("up") }, up && down ? "/" : "", { text: `${down}${compact ? "" : " Choose"}`, run: () => this.act("down") }];
			const open = { text: `${primaryKey("tui.select.confirm")}${compact ? "" : " Open"}`.trim(), run: () => this.act("open") };
			const back = { text: `${primaryKey("tui.select.cancel")}${compact ? "" : " Back"}`.trim(), run: () => this.act("back") };
			const filter = { text: "Type to filter", run: () => this.act("filter") };
			const controls = compact ? [...choose, " · ", open, " · ", back]
				: width < 60 ? [...choose, " · ", open, "\n", back, " · ", filter] : [filter, " · ", ...choose, " · ", open, " · ", back];
			footer.addChild(actionHints(controls, (text) => this.theme.fg("dim", text)));
			const visible = Math.max(1, height - 3 - header.render(innerWidth).length - footer.render(innerWidth).length);
			// Native SelectList needs more than ten cells to show its description column.
			const descriptionWidth = innerWidth > 40 ? Math.max(11, ...items.map((item) => visibleWidth(item.description ?? ""))) : 0;
			const primaryWidth = Math.max(1, innerWidth - descriptionWidth - (descriptionWidth ? 4 : 2));
			this.list = new SelectList(items, visible, getSelectListTheme(), { minPrimaryColumnWidth: Math.min(24, primaryWidth), maxPrimaryColumnWidth: primaryWidth, truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth) });
			this.list.setSelectedIndex(selectedIndex);
			this.list.onSelect = (item) => {
				if (this.controller.listPending && !["retry", "peers"].includes(item.value)) return;
				if (item.value === "next-page" || item.value === "previous-page") this.controller.pageTasks(item.value === "next-page" ? "later" : "earlier");
				else if (item.value === "retry") void this.controller.retry();
				else this.done(item.value);
			};
			this.list.onCancel = () => this.act("back");
			const body = new Box(1, 0, (text) => this.theme.bg("customMessageBg", text));
			body.addChild(header);
			body.addChild(items.length ? this.list : new Text(query ? "No matching agents." : "No agents owned by this session yet.", 0, 0));
			body.addChild(footer);
			this.clear();
			this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
			this.addChild(body);
			this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
			this.signature = signature;
		}
		return super.render(width);
	}
	invalidate(): void { this.signature = ""; super.invalidate(); }
	syncDraft(): void {}
	private act(action: "up" | "down" | "open" | "back" | "filter"): void {
		if (this.closed) return;
		if (action === "back") this.done();
		else if (action === "filter") this.tui.setFocus(this);
		else if (action === "open") { const item = this.list?.getSelectedItem(); if (item) this.list?.onSelect?.(item); }
		else if (this.itemKeys.length) {
			const index = this.itemKeys.indexOf(this.list?.getSelectedItem()?.value ?? "");
			this.list?.setSelectedIndex((index + (action === "up" ? -1 : 1) + this.itemKeys.length) % this.itemKeys.length);
		}
		this.tui.requestRender();
	}
	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, this.controller.shortcut)) { this.done(); return; }
		if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) { this.controller.pageTasks(matchesKey(data, "pageDown") ? "later" : "earlier"); return; }
		if (matchesKey(data, "f5")) { void this.controller.retry(); return; }
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) { this.act("back"); return; }
		if ((["tui.select.up", "tui.select.down", "tui.select.confirm"] as const).some((key) => keys.matches(data, key))) this.list?.handleInput(data);
		else { const previous = this.search.getValue(); this.search.handleInput(data); if (this.search.getValue() !== previous) this.list = undefined; this.controller.filterTasks(this.search.getValue()); }
		this.tui.requestRender();
	}
	dispose(): void { this.closed = true; }
}

/** Native ScrollView owns follow/scroll state; overlays only need a bounded render adapter. */
export class AgentConversation extends Container {
	readonly editor: Editor;
	readonly scroll: ScrollView;
	private viewport: Component;
	private editorViewport: Component;
	private editorHeight = Infinity;
	private editorFocus = true;
	private hasFocus = false;
	private closed = false;
	private beforeInput = "";
	private height = 1;
	private lastWidth?: number;
	private selectedId?: string;
	private detail?: AgentHistoryItem;
	private detailError?: string;
	private menu?: SelectList;
	private lines: Array<{ id: string; entryIds: string[]; start: number; contentStart: number; end: number }> = [];
	private components = new Map<string, { signature: string; item: AgentHistoryItem; component: Component }>();
	private initialPosition = true;
	private initialVisit: Pick<AgentVisit, "anchor" | "readThrough">;
	private restoreAnchor?: Anchor;
	private conversationAnchor?: Anchor;
	private contentItems: AgentHistoryItem[] = [];
	private pendingDetail = false;
	private loadingDetail = false;
	private toolsExpanded = false;
	private toolExpansion = new Map<string, boolean>();
	private pageRequest = 0;
	private detailRequest = 0;
	private loadingPage = false;
	private pageError?: string;
	private latestPage = true;
	private readSequence = -1;
	private seenSource = false;
	private toolDefinitions: Map<string, ConstructorParameters<typeof ToolExecutionComponent>[4]>;
	private keys?: KeybindingsManager;

	private tui: TUI;
	private theme: Theme;
	private controller: AgentViewController;
	readonly key: string;
	private done: (key?: string) => void;

	constructor(tui: TUI, theme: Theme, controller: AgentViewController, key: string, done: (key?: string) => void, keys?: KeybindingsManager) {
		super();
		this.tui = tui; this.theme = theme; this.controller = controller; this.key = key; this.done = done; this.keys = keys;
		this.seenSource = Boolean(this.task?.page?.count);
		this.initialVisit = { anchor: this.visit.anchor, readThrough: this.visit.readThrough };
		const cwd = this.task?.child.launch?.cwd ?? this.task?.run.cwd ?? process.cwd();
		this.toolDefinitions = new Map([createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition].map((create) => { const definition = create(cwd); return [definition.name, definition]; }));
		this.editor = new Editor(tui, { borderColor: (text) => theme.fg("accent", text), selectList: getSelectListTheme() }, { paddingX: 0 });
		this.editor.setText(this.visit.draft);
		this.editor.onChange = () => { if (this.closed) return; this.visit.draft = this.editor.getExpandedText(); this.controller.changed(); };
		this.editor.onSubmit = (text) => {
			this.editor.setText(this.beforeInput);
			if (!this.loadingDetail) void this.controller.send(this.key, text);
		};
		let editorOffset = 0;
		this.editorViewport = {
			invalidate: () => this.editor.invalidate(),
			render: (width) => {
				const lines = this.editor.render(width);
				// Native overlays do not allocate editor height; keep Pi's cursor and input handling intact when space is short.
				const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
				if (cursor >= 0) editorOffset = Math.max(0, cursor - this.editorHeight + 1);
				editorOffset = Math.max(0, Math.min(editorOffset, lines.length - this.editorHeight));
				return lines.slice(editorOffset, editorOffset + this.editorHeight);
			},
			handleMouse: (event) => this.editor.handleMouse({ ...event, y: event.y + editorOffset }),
		};
		this.scroll = new ScrollView({ render: (width) => this.renderHistory(width), invalidate() {} }, { follow: "end", scrollbar: "hidden" });
		this.viewport = { invalidate: () => this.scroll.invalidate(), render: (width) => {
			if (this.lastWidth !== width && !this.scroll.isFollowingEnd) this.restoreAnchor ??= this.anchor();
			this.lastWidth = width;
			const lines = this.scroll.render(width);
			this.scroll.updateLayout(lines.length, this.height, () => this.tui.requestRender());
			if (this.initialPosition && !this.loadingPage && (this.task?.page || this.task?.child.identityUnavailable)) {
				this.initialPosition = false;
				const ids = this.task?.historyIds ?? [];
				const readIndex = this.initialVisit.readThrough ? ids.indexOf(this.initialVisit.readThrough) : -1;
				const unread = this.initialVisit.readThrough === null ? ids[0] : readIndex >= 0 ? ids[readIndex + 1] : undefined;
				this.restoreAnchor = unread ? { id: unread, line: 0 } : this.initialVisit.anchor;
				if (!this.restoreAnchor && this.task?.finalId) {
					this.restoreAnchor = { id: this.task.finalId, line: 0 };
					// The finished report is the starting point; earlier activity stays available above it.
					this.visit.readThrough ??= ids[ids.indexOf(this.task.finalId) - 1] ?? null;
				}
			}
			if (this.restoreAnchor) {
				const line = this.lines.find((line) => line.entryIds.includes(this.restoreAnchor!.id));
				if (line) this.scroll.scrollTo(line.start + Math.min(this.restoreAnchor.line, Math.max(0, line.end - line.start - 1)), { disableFollow: true });
				this.restoreAnchor = undefined;
			}
			const visible = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.height);
			while (visible.length < this.height) visible.push("");
			if (!this.detail && !this.loadingPage && !this.initialPosition) {
				this.visit.anchor = this.scroll.isFollowingEnd ? undefined : this.anchor();
				const ids = this.task?.historyIds ?? [];
				const seen = this.lines.filter((line) => line.end > this.scroll.scrollTop && line.end <= this.scroll.scrollTop + this.height).flatMap((line) => line.entryIds);
				const last = ids.findLastIndex((id) => seen.includes(id));
				if (last >= 0) {
					const id = ids[last]!.startsWith("result:") ? this.task?.page?.latestEntryId ?? ids[last]! : ids[last]!;
					const nativeId = id.replace(/:(?:\d+|error)$/, ""), sequence = this.task?.page?.entries.find((entry) => entry.id === nativeId)?.sequence;
					if (sequence !== undefined && (sequence > this.readSequence || sequence === this.readSequence && last > (this.visit.readThrough ? ids.indexOf(this.visit.readThrough) : -1))) {
						this.visit.readThrough = id; this.readSequence = sequence;
					}
				}
				this.visit.readThrough ??= null;
				if (this.scroll.isFollowingEnd) this.visit.seenActivityAt = this.task?.child.activity?.lastActivityAt ?? Date.now();
			}
			return visible;
		}, handleMouse: (event) => this.historyMouse(event) };
		void this.loadPage({}, this.visit.anchor?.id ?? this.visit.readThrough);
	}

	private async loadPage(paging: Pick<HistoryPageInput, "before" | "after" | "cursor"> = {}, anchor?: string | null): Promise<void> {
		if (this.closed) return;
		const request = ++this.pageRequest;
		this.loadingPage = true; this.pageError = undefined;
		if (this.task) this.task.historyLoading = true;
		this.latestPage = paging.before === undefined && paging.after === undefined && paging.cursor === undefined;
		this.tui.requestRender();
		try {
			let result = await this.controller.historyPage(this.key, paging, anchor);
			if (this.closed || request !== this.pageRequest || !result || !this.task) return;
			if (this.initialPosition && this.initialVisit.readThrough === undefined && !this.initialVisit.anchor && this.task.child.state !== "live" && result.history.finalId && !result.history.entryIds.includes(result.history.finalId)) {
				const reportPage = await this.controller.historyPage(this.key, {}, result.history.finalId);
				if (this.closed || request !== this.pageRequest || !this.task) return;
				if (reportPage) result = reportPage;
			}
			const task = this.task;
			if (result.readThroughSequence !== undefined) this.readSequence = result.readThroughSequence;
			this.latestPage = result.latestPage;
			let history = result.history;
			if ((this.latestPage || history.finalId && history.entryIds.includes(history.finalId)) && task.child.state !== "live" && task.child.result && getSingleResultOutput(task.child.result)) {
				const report = await this.controller.savedResult(this.key, `result:${task.run.runId}`);
				if (this.closed || request !== this.pageRequest || this.task?.run.runId !== task.run.runId) return;
				history = withFinalResult(history, report.text, task.run.runId, task.run.updatedAt);
			}
			task.history = history.items; task.historyIds = history.entryIds; task.finalId = history.finalId; task.page = result.page;
			for (const item of task.history) if (item.id === `result:${task.run.runId}`) item.load = () => this.controller.savedResult(this.key, item.id);
			this.seenSource ||= result.page.count > 0;
			task.unavailable = !this.seenSource && task.child.state === "live" && ["missing", "pending", "indexing", "unlinked"].includes(result.page.sourceState) ? undefined : history.unavailable;
			this.controller.applyMetadata(task, result.page);
			this.components.clear();
		} catch (error) {
			if (!this.closed && request === this.pageRequest) this.pageError = `History unavailable: ${error instanceof Error ? error.message : String(error)}. F5 retries the selected run.`;
		} finally {
			if (!this.closed && request === this.pageRequest) { this.loadingPage = false; if (this.task) this.task.historyLoading = false; this.tui.requestRender(); }
		}
	}

	private get visit(): AgentVisit { return this.controller.visit(this.key); }
	private get task(): AgentTask | undefined { return this.controller.task(this.key); }
	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.editor.focused = value && this.editorFocus && !this.detail && !this.menu; }
	private anchor(): Anchor | undefined {
		const line = this.lines.findLast((line) => line.start <= this.scroll.scrollTop);
		return line ? { id: line.id, line: this.scroll.scrollTop - line.start } : undefined;
	}
	refresh(): void {
		if (this.closed) return;
		if (this.detail?.id === "assignment" && this.task) this.detail = this.assignment();
		if (!this.initialPosition && !this.scroll.isFollowingEnd) this.restoreAnchor = this.anchor();
		if (!this.loadingPage && this.latestPage && this.scroll.isFollowingEnd && !this.detail && !this.pageError) void this.loadPage();
		this.tui.requestRender();
	}
	syncDraft(): void { if (!this.closed && this.editor.getExpandedText() !== this.visit.draft) this.editor.setText(this.visit.draft); }

	private assignment(): AgentHistoryItem {
		const task = this.task!;
		return { id: "assignment", kind: "notice", title: task.child.identityUnavailable ? "Assignment unavailable" : `Assignment · ${task.child.agent}`, text: task.child.identityUnavailable ? UNAVAILABLE_ASSIGNMENT : `${task.model.details}\n\n${task.child.task ?? "The original per-child assignment was not saved for this older run."}`, timestamp: task.run.startedAt };
	}

	private items(): AgentHistoryItem[] {
		const task = this.task;
		if (!task) return [{ id: "unavailable", kind: "notice", title: "Agent unavailable", text: "The owning session or run is no longer available.", timestamp: 0 }];
		if (this.detail) return [this.detail];
		const page = task.page;
		const status = this.pageError ?? (this.loadingPage && !task.page ? "Loading conversation…" : page?.freshness.state === "catching-up" ? "Catching up · partial history" : page?.freshness.state === "degraded" ? "Some saved history unavailable · F5 retry" : undefined);
		const items = [this.assignment(), ...(status ? [{ id: "history-loading", kind: "notice" as const, title: status, text: "", timestamp: 0 }] : []),
			...(page && page.count > page.entries.length ? [{ id: "history-page", kind: "notice" as const, title: `History · ${page.entries.length} of ${page.count} native records${this.latestPage ? " · latest" : ""}`, text: "F2 Actions → Earlier history / Later history / Latest. Full details validates the selected native record.", timestamp: 0 }] : []),
			...(!task.child.identityUnavailable && task.child.state !== "live" ? [{ id: "process-exit", kind: "notice" as const, title: `Agent: ${task.child.state}`, text: formatAgentProcessExit(task.child.result?.agentProcessExit), timestamp: task.run.updatedAt }] : []), ...task.history];
		const humanAction = task.child.humanAction ?? acceptanceHumanAction(task.child.result?.acceptance);
		if (humanAction && !task.child.identityUnavailable) items.push({ id: "human-action", kind: "notice", title: "Needs your action — acceptance incomplete", text: humanAction, timestamp: task.run.updatedAt });
		if (task.unavailable && !task.child.identityUnavailable) items.push({ id: "unavailable", kind: "notice", title: "Conversation unavailable", text: task.unavailable, timestamp: 0 });
		if (task.question) items.push({ id: `question:${task.question.questionId}`, kind: "notice", title: "Waiting for your answer", text: task.question.message, timestamp: task.question.createdAt });
		if (!task.child.identityUnavailable && task.child.state === "live" && task.child.activity?.streamingText) items.push({ id: `live:${task.run.runId}`, kind: "assistant", title: "Agent · writing", text: task.child.activity.streamingText, timestamp: task.child.activity.lastActivityAt ?? 0 });
		for (const sent of this.visit.outbox) items.push({ id: `outgoing:${sent.id}`, kind: "user", title: sent.status === "sending" ? "You · sending" : sent.status === "waiting" ? "You · waiting for the child / tool boundary" : "You · delivery unconfirmed",
			text: `${sent.text}${sent.quote ? `\n\nRegarding ${sent.quote.title}:\n${sent.quote.text}` : ""}${sent.reason ? `\n\n${sent.reason}` : ""}`, timestamp: sent.at });
		return items;
	}

	private renderHistory(width: number): string[] {
		this.contentItems = this.items();
		const visibleIds = new Set(this.contentItems.map((item) => item.id));
		for (const id of this.components.keys()) if (!visibleIds.has(id)) this.components.delete(id);
		this.lines = [];
		const lines: string[] = [];
		for (const item of this.contentItems) {
			const selected = item.id === this.selectedId && !this.editorFocus;
			const expanded = Boolean(this.detail) || (this.toolExpansion.get(item.id) ?? this.toolsExpanded);
			// Native cards and selected details are immutable snapshots. Comparing
			// identity avoids evaluating/serializing their potentially large bodies.
			const signature = `${expanded}:${Boolean(this.detail)}`;
			let cached = this.components.get(item.id);
			const sameDisplay = cached && !item.load && !cached.item.load && !item.assistant && !cached.item.assistant && !item.call && !cached.item.call && !item.result && !cached.item.result
				&& item.kind === cached.item.kind && item.title === cached.item.title && item.text === cached.item.text
				&& item.details === cached.item.details && item.diff === cached.item.diff && item.model === cached.item.model
				&& item.timestamp === cached.item.timestamp && item.messageId === cached.item.messageId;
			if (cached?.signature !== signature || cached.item !== item && !sameDisplay) {
				const component = new Container();
				if (this.detail && item.model) component.addChild(new Text(this.theme.fg("muted", `Message model: ${readableText(formatModelThinking(item.model))}`), 0, 0));
				if (item.call || item.result) {
					const name = item.call?.name ?? item.result!.toolName;
					const definition = (item.call && this.toolDefinitions.get(name)) || { renderCall: () => new Text(this.theme.fg("toolTitle", this.theme.bold(readableText(item.title))), 0, 0) };
					const options = { compactView: true, showImages: false };
					const tool = new ToolExecutionComponent(name, item.call?.id ?? item.result!.toolCallId, item.call?.arguments ?? {}, options, definition, this.tui, this.task?.child.launch?.cwd ?? this.task?.run.cwd ?? process.cwd());
					// Replay only saved data: execution/args-complete hooks would invent timing or re-read today's file for an edit preview.
					if (item.result) tool.updateResult(item.result);
					tool.setExpanded(expanded);
					component.addChild(tool);
					// Native edit cards already show their recorded diff.
					if (this.detail && item.diff && item.call?.name !== "edit") component.addChild(new Text(renderDiff(item.diff), 0, 0));
					if (!item.result) component.addChild(new Text(this.theme.fg("dim", "Result not recorded · exit unconfirmed"), 1, 0));
				} else if (item.kind === "assistant" || item.kind === "thinking") {
					// Live text and canonical reports are display-only, never saved as synthetic model messages.
					const message: AssistantMessage = item.assistant ?? { role: "assistant", content: [{ type: "text", text: item.text }], timestamp: item.timestamp,
						api: "", provider: "", model: "", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					component.addChild(new AssistantMessageComponent(this.detail ? message : { ...message, content: message.content.map((part) => part.type === "text" ? { ...part, text: stripAcceptanceReport(readableText(part.text)) } : part) }, !this.detail, getMarkdownTheme(), "Thinking · open details to read"));
				} else if (item.kind === "user") {
					if (item.id.startsWith("outgoing:") || item.messageId) component.addChild(new Text(this.theme.fg("muted", item.title), 0, 0));
					component.addChild(new UserMessageComponent(item.text, getMarkdownTheme(), 1));
				} else {
					component.addChild(new Text(this.theme.fg("muted", readableText(item.title)), 0, 0));
					component.addChild(new Text(item.text, 0, 0));
					if (item.diff) component.addChild(new Text(renderDiff(item.diff), 0, 0));
				}
				if (this.detail && item.details) component.addChild(new Text(item.details, 0, 1));
				component.addChild(new Spacer(1));
				cached = { signature, item, component }; this.components.set(item.id, cached);
			}
			const start = lines.length;
			if (selected) lines.push(this.theme.fg("accent", short(`› ${item.title}`, width)));
			const contentStart = lines.length;
			lines.push(...cached.component.render(width));
			this.lines.push({ id: item.id, entryIds: item.entryIds ?? [item.id], start, contentStart, end: lines.length });
		}
		return lines;
	}

	render(width: number): string[] {
		const task = this.task, innerWidth = Math.max(1, width - 2);
		const height = this.controller.availableHeight(this.tui), compact = height < 16;
		const terminal = task?.child.state !== "live" && !task?.question;
		const primary = task?.child.identityUnavailable || task?.child.activity?.status === "pending" ? undefined : terminal ? "continue" : this.editorFocus ? "send" : "details";
		const actionHint = this.loadingDetail && !this.detail ? "Loading quoted context…" : task?.child.identityUnavailable ? "Assignment unavailable · draft kept" : task?.child.activity?.status === "pending" ? "Waiting to start · draft kept" : terminal ? width < 60 ? "Alt+C Continue" : "Alt+C Continue with message" : this.editorFocus ? `${primaryKey("tui.input.submit")} Send`.trim() : "Enter Details";
		const primaryHint = primary ? { text: actionHint, run: () => this.act(primary) } : actionHint;
		const actions = { text: compact ? "F2" : "F2 Actions", run: () => this.act("actions") };
		const focus = { text: compact ? "Tab" : "Tab Read/write", run: () => this.act("focus") };
		const reply = { text: compact ? "Alt+R" : "Alt+R Reply", run: () => this.act("reply") };
		const back = { text: this.menu ? `${primaryKey("tui.select.cancel")}${compact ? "" : this.detail ? " Back to details" : " Back to conversation"}`.trim() : compact ? "Esc" : "Esc Back", run: () => this.act("back") };
		const choose = { text: `${primaryKey("tui.select.confirm")}${compact ? "" : " Choose"}`.trim(), run: () => this.act("choose") };
		const controls = this.menu ? [choose, " · ", back] : this.detail ? [reply, " · ", actions, " · ", back] : compact ? [actions, " · ", focus, " · ", back]
			: width < 60 ? [actions, " · ", back, "\n", primaryHint, " · ", focus] : [primaryHint, " · ", actions, " · ", focus, " · ", back];
		const footer = actionHints(controls, this.menu ? undefined : (text) => this.theme.fg("dim", text));
		// Reserve title, controls and required content before spending rows on status or borders.
		const contentRows = this.menu ? this.menu.render(innerWidth).length : 1 + (this.detail ? 0 : 1 + Number(!compact) + Number(Boolean(this.visit.notice)) + Number(Boolean(this.visit.quote)));
		const requiredRows = 1 + footer.render(innerWidth).length + contentRows;
		const showStatus = height > requiredRows;
		const framed = height >= requiredRows + Number(showStatus) + 2;
		this.clear();
		const body = new Box(1, 0, (text) => this.theme.bg("customMessageBg", text));
		const header = new Container();
		header.addChild(new Text(this.theme.fg("accent", this.theme.bold(truncateToWidth(`${this.loadingPage && !task?.page && !this.detail ? "Loading conversation…" : this.pageError && !this.detail ? "History unavailable · F5 retry" : "Agents"} › ${task?.label ?? "unavailable"}${this.detail ? " › details" : ""}`, innerWidth))), 0, 0));
		if (showStatus) header.addChild(actionHints([
			...(task?.unread && !this.scroll.isFollowingEnd ? ["New activity · ", ...(this.menu ? [] : [{ text: "Alt+L latest", run: () => this.act("latest") }, " · "])] : []),
			task ? `${task.child.agent} · ${activity(task)} · ${task.model.summary}` : "Unavailable",
		], (text) => this.theme.fg("dim", text), "..."));
		body.addChild(header);
		if (this.menu) {
			body.addChild(this.menu);
			body.addChild(footer);
		} else {
			const bottom = new Container();
			if (!this.detail) {
				const notice = this.visit.notice;
				if (notice) bottom.addChild(actionHints(typeof notice === "string" ? [readableText(notice).replace(/\s+/g, " ").trim()]
					: [CONTINUE_NOTICES[notice.continue], { text: CONTINUE_HINT, run: () => this.act("continue") }, "."], (text) => this.theme.fg("warning", text), "..."));
				if (this.visit.quote) bottom.addChild(actionHints(["Quote · ", { text: "Alt+Q remove", run: () => this.act("unquote") }, ": ", this.visit.quote.title], (text) => this.theme.fg("dim", text), "..."));
				if (!compact) bottom.addChild(new Text(this.theme.fg("accent", truncateToWidth(`${task?.question ? "Answer" : "Message"} ${task?.label ?? "agent"}${this.controller.isBusy(this.key) ? " · sending" : ""}`, innerWidth)), 0, 0));
				bottom.addChild(this.editorViewport);
			}
			bottom.addChild(footer);
			const space = height - (framed ? 2 : 0) - header.render(innerWidth).length;
			this.editorHeight = Infinity;
			const bottomHeight = bottom.render(innerWidth).length;
			if (!this.detail) this.editorHeight = Math.max(1, space - (bottomHeight - this.editor.render(innerWidth).length) - 1);
			this.height = Math.max(1, space - bottom.render(innerWidth).length);
			body.addChild(this.viewport); body.addChild(bottom);
		}
		if (framed) this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
		this.addChild(body);
		if (framed) this.addChild(new DynamicBorder((text) => this.theme.fg("borderAccent", text)));
		this.focused = this.hasFocus;
		return super.render(width);
	}

	invalidate(): void { this.components.clear(); super.invalidate(); }

	handleMouse(event: TuiMouseEvent) {
		const result = super.handleMouse(event);
		if (result?.target.component === this.editorViewport) { this.editorFocus = true; this.focused = this.hasFocus; }
		return result;
	}

	private historyMouse(event: TuiMouseEvent) {
		if (event.type === "wheel") { this.scroll.scrollBy(event.wheelDelta ?? 0); this.restoreAnchor = this.anchor(); return { handled: true }; }
		if (event.type !== "click" || event.button !== "left") return;
		const line = this.lines.find((line) => line.start <= event.y + this.scroll.scrollTop && line.end > event.y + this.scroll.scrollTop);
		if (!line) return;
		this.restoreAnchor = this.anchor();
		this.editorFocus = false;
		this.selectedId = line.id;
		const item = this.selected();
		if ((item?.call || item?.result) && !this.detail) this.toolExpansion.set(line.id, !(this.toolExpansion.get(line.id) ?? this.toolsExpanded));
		else this.components.get(line.id)?.component.handleMouse?.({ ...event, y: event.y + this.scroll.scrollTop - line.contentStart, height: line.end - line.contentStart });
		return { handled: true, focus: true };
	}

	private select(delta: number): void {
		const current = this.lines.findIndex((line) => line.id === this.selectedId);
		const index = Math.max(0, Math.min(this.lines.length - 1, (current < 0 ? this.lines.findIndex((line) => line.end > this.scroll.scrollTop) : current) + delta));
		const line = this.lines[index];
		if (!line) return;
		this.selectedId = line.id;
		if (line.start < this.scroll.scrollTop || line.start >= this.scroll.scrollTop + this.height) this.scroll.scrollTo(line.start, { disableFollow: true });
		this.restoreAnchor = this.anchor();
	}

	private selected(): AgentHistoryItem | undefined { return this.detail ?? this.contentItems.find((item) => item.id === this.selectedId) ?? this.contentItems.findLast((item) => item.kind === "assistant"); }
	private async inspect(item: AgentHistoryItem): Promise<void> {
		const request = ++this.detailRequest, runId = this.task?.run.runId;
		this.conversationAnchor = this.scroll.isFollowingEnd ? undefined : this.anchor();
		this.loadingDetail = Boolean(item.load); this.detailError = undefined;
		this.detail = item.load ? { id: item.id, kind: "notice", title: "Loading selected details…", text: "Native record validation is running in the history process.", timestamp: item.timestamp } : item;
		this.menu = undefined; this.editorFocus = false;
		this.scroll.scrollToStart(); this.restoreAnchor = { id: item.id, line: 0 };
		this.tui.requestRender();
		try {
			const detail = item.load ? await item.load() : item;
			if (!this.closed && request === this.detailRequest && this.task?.run.runId === runId) this.detail = detail;
		} catch (error) {
			if (!this.closed && request === this.detailRequest && this.task?.run.runId === runId) {
				this.detailError = readableText(error instanceof Error ? error.message : String(error));
				this.detail = { id: item.id, kind: "notice", title: "Details unavailable", text: this.detailError, timestamp: item.timestamp };
			}
		}
		if (!this.closed && request === this.detailRequest) { this.loadingDetail = false; this.tui.requestRender(); }
	}
	private async reply(): Promise<void> {
		if (this.loadingDetail) return;
		if (this.detail && this.detailError) {
			this.visit.notice = `Quoted context unavailable; draft kept. ${this.detailError}`;
			this.act("back"); this.controller.changed(); return;
		}
		let item = this.selected();
		if (!item) return;
		const anchor = this.detail ? this.conversationAnchor : this.scroll.isFollowingEnd ? undefined : this.anchor();
		if (item.load && !this.detail) {
			const request = ++this.detailRequest, runId = this.task?.run.runId;
			this.loadingDetail = true; this.editorFocus = true; this.focused = this.hasFocus; this.tui.requestRender();
			try {
				item = await item.load();
				if (this.closed || request !== this.detailRequest || this.task?.run.runId !== runId) return;
			} catch (error) {
				if (!this.closed && request === this.detailRequest) { this.visit.notice = `Quoted context unavailable; draft kept. ${readableText(error instanceof Error ? error.message : String(error))}`; this.controller.changed(); }
				return;
			} finally {
				if (!this.closed && request === this.detailRequest) { this.loadingDetail = false; this.tui.requestRender(); }
			}
		}
		this.visit.quote = { title: item.title, text: (item.call || item.result ? [item.diff, item.details ?? item.text] : [item.text, item.diff, item.details]).filter(Boolean).join("\n\n") };
		this.detailRequest++; this.detail = undefined; this.menu = undefined; this.editorFocus = true;
		this.restoreAnchor = anchor; this.controller.changed();
	}
	private actions(): void {
		const task = this.task;
		const choices = [
			{ value: "reply", label: "Reply to selected message / tool / change" },
			{ value: "details", label: "Full details / diff" },
			{ value: "expand", label: this.toolsExpanded ? "Collapse tool output" : "Expand tool output" },
			{ value: "assignment", label: "Full original assignment" },
			{ value: "changes", label: "Inspect working tree changes" },
			{ value: "latest", label: "Jump to latest activity" },
			{ value: "pin", label: this.controller.pinned === this.key ? "Unpin this agent" : "Keep this agent visible" },
			...(this.visit.quote ? [{ value: "unquote", label: "Remove quoted context" }] : []),
			...(task?.child.identityUnavailable || task?.child.activity?.status === "pending" ? [] : task?.child.state === "live" || task?.question ? [{ value: "stop", label: "Stop this agent only" }] : [{ value: "continue", label: "Continue with this message" }]),
			{ value: "picker", label: "Your other agents" }, { value: "peers", label: "Other connected sessions" },
			{ value: "earlier", label: "Earlier history" },
			{ value: "later", label: "Later history" },
			{ value: "retry", label: "Refresh / retry selected history" },
		];
		this.menu = new SelectList(choices, Math.max(1, this.controller.availableHeight(this.tui) - 7), getSelectListTheme());
		this.menu.onSelect = (item) => { this.menu = undefined; this.act(item.value); };
		this.menu.onCancel = () => { this.menu = undefined; };
	}
	private act(action: string): void {
		if (this.closed) return;
		if (action === "back") {
			if (this.menu) this.menu.onCancel?.();
			else if (this.detail) { this.detailRequest++; this.loadingDetail = false; this.detail = undefined; this.editorFocus = true; this.restoreAnchor = this.conversationAnchor; if (!this.restoreAnchor) this.scroll.scrollToEnd(); }
			else this.finish();
		} else if (action === "choose") { const item = this.menu?.getSelectedItem(); if (item) this.menu?.onSelect?.(item); }
		else if (action === "actions") this.actions();
		else if (action === "focus" && !this.detail) { this.editorFocus = !this.editorFocus; if (!this.editorFocus) this.select(0); }
		else if (action === "send" && !this.loadingDetail) void this.controller.send(this.key, this.editor.getExpandedText().trim());
		else if (action === "reply") void this.reply();
		else if (action === "details") { const item = this.selected(); if (item) void this.inspect(item); }
		else if (action === "earlier" || action === "later") {
			const page = this.task?.page;
			if (action === "earlier" && page?.previousBefore !== undefined) void this.loadPage({ before: page.previousBefore });
			else if (action === "later" && !this.latestPage && page?.nextAfter !== undefined) void this.loadPage({ after: page.nextAfter });
			this.components.clear(); this.selectedId = undefined; this.scroll.scrollToEnd(); this.tui.requestRender();
		}
		else if (action === "retry") { void this.controller.retry(this.key).then(() => { if (!this.closed) void this.loadPage(); }); }
		else if (action === "assignment" && this.task) void this.inspect(this.assignment());
		else if (action === "expand") {
			if (!this.scroll.isFollowingEnd) this.restoreAnchor = this.anchor();
			this.toolsExpanded = !this.toolsExpanded; this.toolExpansion.clear();
		}
		else if (action === "changes" && !this.pendingDetail) {
			const request = ++this.detailRequest, runId = this.task?.run.runId;
			this.pendingDetail = true;
			void this.controller.changes(this.key).then((item) => { if (!this.closed && request === this.detailRequest && this.task?.run.runId === runId && item) { void this.inspect(item); this.tui.requestRender(); } })
				.catch((error) => { if (!this.closed && request === this.detailRequest && this.task?.run.runId === runId) this.visit.notice = `Changes unavailable: ${String(error)}`; }).finally(() => { this.pendingDetail = false; });
		} else if (action === "latest") {
			this.initialPosition = false;
			this.detailRequest++; this.loadingDetail = false; this.detail = undefined; this.components.clear();
			void this.loadPage();
			this.restoreAnchor = undefined; this.conversationAnchor = undefined; this.scroll.scrollToEnd();
			this.selectedId = this.editorFocus ? undefined : this.items().at(-1)?.id;
		}
		else if (action === "pin") this.controller.pin(this.controller.pinned === this.key ? undefined : this.key);
		else if (action === "unquote") { if (this.loadingDetail && !this.detail) { this.detailRequest++; this.loadingDetail = false; } this.visit.quote = undefined; this.controller.changed(); }
		else if (action === "stop") void this.controller.stop(this.key);
		else if (action === "continue" && !this.loadingDetail) void this.controller.send(this.key, this.editor.getExpandedText(), true);
		else if (action === "picker" || action === "peers") this.finish(action);
		this.focused = this.hasFocus;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, this.controller.shortcut)) { this.finish(); return; }
		if (this.menu) { this.menu.handleInput(data); this.tui.requestRender(); return; }
		if (matchesKey(data, "escape")) this.act("back");
		else if (this.keys?.matches(data, "app.tools.expand") ?? matchesKey(data, "ctrl+o")) this.act("expand");
		else if (matchesKey(data, "f2")) this.act("actions");
		else if (matchesKey(data, "f5")) this.act("retry");
		else if (matchesKey(data, "alt+r")) this.act("reply");
		else if (matchesKey(data, "alt+d") && (!this.editorFocus || this.detail)) this.act("details");
		else if (matchesKey(data, "alt+g")) this.act("changes");
		else if (matchesKey(data, "alt+l")) this.act("latest");
		else if (matchesKey(data, "alt+p")) this.act("pin");
		else if (matchesKey(data, "alt+q")) this.act("unquote");
		else if (matchesKey(data, "alt+s")) this.act("stop");
		else if (matchesKey(data, "alt+c")) this.act("continue");
		else if (matchesKey(data, "tab") && !this.detail) this.act("focus");
		else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) { this.scroll.scrollBy(matchesKey(data, "pageUp") ? -this.height : this.height); this.restoreAnchor = this.anchor(); }
		else if (!this.editorFocus || this.detail) {
			if (matchesKey(data, "up")) this.select(-1);
			else if (matchesKey(data, "down")) this.select(1);
			else if (matchesKey(data, "home")) { this.scroll.scrollToStart(); this.restoreAnchor = this.anchor(); }
			else if (matchesKey(data, "end")) this.act("latest");
			else if (matchesKey(data, "enter")) this.act("details");
		} else { this.beforeInput = this.editor.getExpandedText(); this.editor.handleInput(data); }
		this.focused = this.hasFocus;
		this.tui.requestRender();
	}

	private finish(key?: string): void { this.controller.changed(); this.done(key); }
	dispose(): void { this.closed = true; this.pageRequest++; this.detailRequest++; this.editor.onChange = undefined; this.editor.onSubmit = undefined; this.components.clear(); }
}
