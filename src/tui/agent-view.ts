import { randomUUID } from "node:crypto";
import { getMarkdownTheme, getSelectListTheme, renderDiff, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Markdown, MouseRegion, ScrollView, SelectList, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { sendLiveSubagentMessage } from "../intercom/live-intercom.ts";
import { ownedRunView } from "../runs/shared/run-records.ts";
import { listRunQuestions, getRunMetadataDir, questionProcessAlive, type SupervisorQuestionView } from "../runs/shared/supervisor-questions.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-params.ts";
import { getSingleResultOutput } from "../shared/utils.ts";
import { isTuiContext } from "../shared/ui-mode.ts";
import { acceptanceHumanAction } from "../runs/shared/acceptance.ts";
import { formatAgentProcessExit } from "../shared/status-format.ts";
import { WIDGET_KEY, type OwnedRun, type OwnedRunView, type SubagentExecutionResult, type SubagentState } from "../shared/types.ts";
import { buildWidgetLines } from "./render.ts";
import { NativeAgentHistory, readableText, type AgentHistoryItem } from "./agent-history.ts";

const VIEW_ENTRY = "subagent-view";
const DIRECTION_MESSAGE = "subagent-human-direction";
const PENDING_MESSAGE_NOTICE = "This message is already waiting for the child. You can keep working or write a different message.";
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
	readThrough?: string;
	seenActivityAt?: number;
	outbox: OutgoingMessage[];
	lastSentId?: string;
	notice?: string;
}
export interface AgentTask {
	key: string;
	label: string;
	run: OwnedRunView;
	child: OwnedRunView["children"][number];
	question?: SupervisorQuestionView;
	history: AgentHistoryItem[];
	unavailable?: string;
	unread: boolean;
	replied: boolean;
}

const short = (text: string, width = 48) => truncateToWidth(readableText(text).replace(/\s+/g, " ").trim(), width);
const resultText = (result: SubagentExecutionResult) => result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
export function agentTaskLabel(child: OwnedRunView["children"][number]): string {
	return short(child.label || child.task?.split("\n").find((line) => line.trim()) || `${child.agent} · assignment unavailable`, 42);
}
function activity(task: AgentTask): string {
	if (task.question) return task.question.state === "answer_pending" ? "answer saved · waiting" : "needs an answer";
	if (task.child.state === "blocked") return "needs your action · acceptance incomplete";
	if (task.child.state !== "live") return task.child.state === "completed" ? "done" : task.child.state;
	const live = task.child.activity;
	if (live?.status === "pending") return "waiting to start";
	return live?.currentTool ? short(`${live.currentTool} ${live.currentToolArgs || live.currentPath || ""}`, 42)
		: live?.streamingText ? short(live.streamingText, 42) : "working";
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
	private history = new NativeAgentHistory();
	private views = new Map<string, { run: OwnedRun; view: OwnedRunView }>();
	private visits = new Map<string, AgentVisit>();
	private busy = new Set<string>();
	private lastSaved = "";
	private render?: () => void;
	private closeOverlay?: () => void;
	private overlay?: AgentConversation | AgentPicker;
	tasks: AgentTask[] = [];
	pinned?: string;

	private pi: ExtensionAPI;
	private state: SubagentState;
	private execute: ExecuteControl;

	constructor(pi: ExtensionAPI, state: SubagentState, execute: ExecuteControl) {
		this.pi = pi; this.state = state; this.execute = execute;
		pi.registerCommand("agents", { description: "View, message, answer, stop, or continue your agents", handler: async (_args, ctx) => this.open(undefined, ctx) });
		pi.registerMessageRenderer(DIRECTION_MESSAGE, (message, options, theme) => {
			const details = message.details as { label: string; text: string; quote?: Quote };
			return new Text(options.expanded ? `User → ${details.label}\n${details.text}${details.quote ? `\n\nReplying to ${details.quote.title}:\n${details.quote.text}` : ""}`
				: theme.fg("dim", `User → ${details.label}: ${short(details.text, 100)} · sent directly · Ctrl+O`), 0, 0);
		});
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
			return new MouseRegion({
				invalidate() {},
				render: (width) => {
					const entrance = "Agents [Alt+M]";
					let line = entrance;
					hits = [{ start: 0, end: entrance.length, row: 0 }];
					const visible = this.tasks.filter((task) => task.child.state === "live" || task.child.state === "blocked" || task.question || task.unread);
					for (const [index, task] of visible.entries()) {
						const text = `  ${task.label}: ${activity(task)}${task.unread ? task.replied ? " · replied" : " · new" : ""}`;
						const start = visibleWidth(line);
						if (start + visibleWidth(text) > width && index > 0) { line += `  +${visible.length - index}`; break; }
						line += text;
						hits.push({ start, end: visibleWidth(line), row: 0, key: task.key });
					}
					if (!visible.length && this.tasks.length) line += `  ${this.tasks.length} saved`;
					const lines = [theme.fg("muted", truncateToWidth(line, width))];
					const pinned = this.tasks.find((task) => task.key === this.pinned);
					if (pinned) {
						const last = pinned.history.findLast((item) => item.kind === "assistant")?.text;
						const preview = pinned.child.state === "live" ? activity(pinned) : (pinned.child.result && getSingleResultOutput(pinned.child.result)) || last || activity(pinned);
						const unpin = "[Unpin] ";
						lines.push(theme.fg("dim", truncateToWidth(`${unpin}${pinned.label}: ${short(preview, width)}`, width)));
						hits.push({ start: 0, end: unpin.length, row: 1, unpin: true }, { start: unpin.length, end: width, row: 1, key: pinned.key });
					}
					if (ctx.ui.getToolsExpanded()) lines.push(...buildWidgetLines([...this.state.asyncJobs.values()], theme, width, true));
					return lines;
				},
			}, (event) => {
				if (tui.mode !== "fullscreen" || event.type !== "click" || event.button !== "left" || !this.live()) return;
				const hit = hits.find((hit) => hit.row === event.y && event.x >= hit.start && event.x < hit.end);
				if (!hit) return;
				if (hit.unpin) this.pin(undefined); else void this.open(hit.key);
				return { handled: true };
			});
		});
		this.refresh(true);
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

	private taskKey(run: OwnedRun, index: number): string {
		const predecessor = run.predecessorRunId && this.state.ownedRuns?.get(run.predecessorRunId);
		return predecessor ? this.taskKey(predecessor, run.predecessorIndex ?? 0) : `${run.runId}:${index}`;
	}

	refresh(force = false): void {
		if (!this.live()) return;
		const tasks = new Map<string, AgentTask>();
		for (const run of this.state.ownedRuns?.values() ?? []) {
			if (run.ownerSessionId !== this.ctx!.sessionManager.getSessionId()) continue;
			const cached = this.views.get(run.runId);
			let view: OwnedRunView;
			let questions: SupervisorQuestionView[] = [];
			try {
				questions = listRunQuestions(getRunMetadataDir(run.runId));
				view = !force && cached?.run === run && !["live", "unknown"].includes(cached.view.state) ? cached.view : ownedRunView(run, this.state);
				this.views.set(run.runId, { run, view });
			} catch (error) {
				view = { ...run, state: "unknown", updatedAt: run.startedAt, attention: ["unknown"], canInterrupt: false, continuations: [],
					children: run.children.map((child) => ({ ...child, state: "unknown", configuration: "legacy-partial" })),
					diagnosis: `Run details unavailable: ${error instanceof Error ? error.message : String(error)}` };
			}
			for (const child of view.children) {
				const key = this.taskKey(run, child.index);
				const prior = tasks.get(key);
				if (prior && prior.run.startedAt > run.startedAt) continue;
				const visit = this.visits.get(key);
				const history = this.history.read(child.sessionFile, child.state === "live");
				const readIndex = visit?.readThrough ? history.items.findIndex((item) => item.id === visit.readThrough) : -1;
				const lastSent = visit?.lastSentId ? history.items.findIndex((item) => item.messageId === visit.lastSentId) : -1;
				if (visit) {
					if (lastSent >= 0 && visit.notice === PENDING_MESSAGE_NOTICE) visit.notice = undefined;
					for (const sent of visit.outbox) {
						if (!history.items.some((item) => item.messageId === sent.id)) continue;
						if (visit.draft === sent.draft) { visit.draft = ""; visit.quote = undefined; this.overlay?.syncDraft(); }
					}
					visit.outbox = visit.outbox.filter((sent) => !history.items.some((item) => item.messageId === sent.id));
				}
				tasks.set(key, { key, label: prior?.label ?? agentTaskLabel(child), run: view, child, history: history.items, unavailable: history.unavailable ?? view.diagnosis,
					question: questions.findLast((question) => question.index === child.index && (question.state === "awaiting_input" || question.state === "answer_pending")),
					unread: Boolean(visit && ((visit.readThrough && readIndex < history.items.length - 1) || (child.activity?.lastActivityAt ?? 0) > (visit.seenActivityAt ?? 0))),
					replied: lastSent >= 0 && history.items.slice(lastSent + 1).some((item) => item.kind === "assistant") });
			}
		}
		this.tasks = [...tasks.values()].sort((a, b) => Number(Boolean(b.question)) - Number(Boolean(a.question)) || Number(b.child.state === "live") - Number(a.child.state === "live") || Number(b.unread) - Number(a.unread) || b.run.startedAt - a.run.startedAt);
		this.overlay?.refresh();
		this.render?.();
		const watching = Boolean(this.overlay) || this.tasks.some((task) => task.run.state === "live" || task.question);
		if (watching && !this.timer) { this.timer = setInterval(() => this.refresh(), 500); this.timer.unref?.(); }
		if (!watching && this.timer) { clearInterval(this.timer); this.timer = undefined; }
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

	private save(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		if (!this.live()) return;
		const saved = { ownerSessionId: this.ctx!.sessionManager.getSessionId(), visits: [...this.visits], pinned: this.pinned };
		const serialized = JSON.stringify(saved);
		if (serialized === this.lastSaved) return;
		this.lastSaved = serialized;
		this.pi.appendEntry(VIEW_ENTRY, saved);
	}

	pin(key: string | undefined): void { this.pinned = key; this.save(); this.render?.(); }

	async open(key?: string, ctx = this.ctx): Promise<void> {
		if (!ctx || !isTuiContext(ctx)) return;
		if (!this.ctx || this.ctx.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) this.start(ctx);
		if (!this.live() || this.overlay) return;
		const generation = this.generation;
		this.refresh(true);
		let selected = key ?? (this.tasks.length === 1 ? this.tasks[0]!.key : undefined);
		while (this.live(generation)) {
			const result = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
				this.closeOverlay = () => done(undefined);
				this.overlay = selected && this.task(selected)
					? new AgentConversation(tui, theme, this, selected, done)
					: new AgentPicker(tui, theme, this, done);
				return this.overlay;
			}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } });
			if (!this.live(generation)) return;
			this.overlay = undefined;
			this.closeOverlay = undefined;
			this.save();
			this.refresh();
			if (result === "peers") { this.pi.events.emit("intercom:open", {}); return; }
			if (!result) return;
			selected = result === "picker" ? undefined : result;
		}
	}

	private breadcrumb(task: AgentTask, text: string, quote?: Quote): void {
		this.pi.sendMessage({ customType: DIRECTION_MESSAGE, display: true,
			content: `For context only: the user sent this directly to ${task.label} (run ${task.run.runId}, child ${task.child.index}). No relay or approval is needed.\n\n${text}${quote ? `\n\nRegarding ${quote.title}:\n${quote.text}` : ""}`,
			details: { label: task.label, text, quote, runId: task.run.runId, index: task.child.index } }, { triggerTurn: false });
	}

	async send(key: string, text: string, continueExplicitly = false): Promise<void> {
		if (!text.trim() || !this.live() || this.busy.has(key)) return;
		this.refresh(true);
		const task = this.task(key), visit = this.visit(key), generation = this.generation;
		if (!task) return;
		if (task.child.activity?.status === "pending") return;
		const question = task.question;
		const liveQuestion = question && questionProcessAlive(question);
		if (task.child.state !== "live" && !liveQuestion && !continueExplicitly) {
			visit.notice = `${task.child.state === "blocked" ? "This agent needs your action; acceptance is incomplete." : "This agent has finished."} Your draft is kept. Choose Continue with this message (Alt+C).`;
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
			if (this.live(generation)) { this.busy.delete(key); this.refresh(true); this.overlay?.syncDraft(); this.save(); }
		}
	}

	async stop(key: string): Promise<void> {
		if (!this.live() || this.busy.has(key)) return;
		this.refresh(true);
		const task = this.task(key);
		if (!task || (task.child.state !== "live" && !task.question)) return;
		if (task.child.activity?.status === "pending") return;
		const generation = this.generation;
		this.busy.add(key);
		try {
			const result = await this.execute({ action: "interrupt", id: task.run.runId, index: task.child.index }, this.ctx!);
			if (!this.live(generation)) return;
			this.visit(key).notice = result.isError ? resultText(result) : "Stop requested for this child only. Independent siblings continue; dependent workflow steps may not run.";
		} catch (error) {
			if (this.live(generation)) this.visit(key).notice = `Stop not confirmed: ${error instanceof Error ? error.message : String(error)}`;
		} finally { if (this.live(generation)) { this.busy.delete(key); this.refresh(true); this.changed(); } }
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
		if (this.timer) clearInterval(this.timer);
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.timer = this.saveTimer = undefined;
		this.render = undefined;
		this.ctx = undefined;
		this.ownerSessionId = undefined;
		this.tasks = [];
		this.views.clear(); this.visits.clear(); this.busy.clear(); this.history.clear();
		this.pinned = undefined; this.lastSaved = "";
	}
}

class AgentPicker extends Container {
	private list?: SelectList;
	private signature = "";
	private tui: TUI;
	private theme: Theme;
	private controller: AgentViewController;
	private done: (key?: string) => void;
	constructor(tui: TUI, theme: Theme, controller: AgentViewController, done: (key?: string) => void) {
		super();
		this.tui = tui; this.theme = theme; this.controller = controller; this.done = done;
		this.refresh();
	}
	refresh(): void {
		const items = [...this.controller.tasks.map((task) => ({ value: task.key, label: task.label, description: `${activity(task)}${task.unread ? " · new activity" : ""}` })), { value: "peers", label: "Other connected sessions", description: "Peer messaging · all projects" }];
		const signature = JSON.stringify(items);
		if (signature === this.signature) return;
		this.signature = signature;
		const selected = this.list?.getSelectedItem()?.value;
		this.list = new SelectList(items, Math.max(1, this.tui.terminal.rows - 7), getSelectListTheme());
		this.list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === selected)));
		this.list.onSelect = (item) => this.done(item.value);
		this.list.onCancel = () => this.done();
		this.clear();
		this.addChild(new Text(this.theme.bold("Agents · your delegated work"), 0, 0));
		if (!this.controller.tasks.length) this.addChild(new Text("No agents owned by this session yet.", 0, 0));
		this.addChild(this.list);
		this.addChild(new Text("Enter Open · Esc Back", 0, 0));
		this.tui.requestRender();
	}
	syncDraft(): void {}
	handleInput(data: string): void { this.list?.handleInput(data); }
	dispose(): void {}
}

/** Native ScrollView owns follow/scroll state; overlays only need a bounded render adapter. */
export class AgentConversation extends Container {
	readonly editor: Editor;
	readonly scroll: ScrollView;
	private viewport: Component;
	private editorFocus = true;
	private hasFocus = false;
	private closed = false;
	private beforeInput = "";
	private height = 1;
	private lastWidth?: number;
	private selectedId?: string;
	private detail?: AgentHistoryItem;
	private menu?: SelectList;
	private lines: Array<{ id: string; start: number; end: number }> = [];
	private components = new Map<string, { signature: string; component: Component }>();
	private initialPosition = true;
	private restoreAnchor?: Anchor;
	private conversationAnchor?: Anchor;
	private contentItems: AgentHistoryItem[] = [];
	private pendingDetail = false;

	private tui: TUI;
	private theme: Theme;
	private controller: AgentViewController;
	readonly key: string;
	private done: (key?: string) => void;

	constructor(tui: TUI, theme: Theme, controller: AgentViewController, key: string, done: (key?: string) => void) {
		super();
		this.tui = tui; this.theme = theme; this.controller = controller; this.key = key; this.done = done;
		this.editor = new Editor(tui, { borderColor: (text) => theme.fg("accent", text), selectList: getSelectListTheme() }, { paddingX: 0 });
		this.editor.setText(this.visit.draft);
		this.editor.onChange = () => { if (this.closed) return; this.visit.draft = this.editor.getExpandedText(); this.controller.changed(); };
		this.editor.onSubmit = (text) => {
			this.editor.setText(this.beforeInput);
			void this.controller.send(this.key, text);
		};
		this.scroll = new ScrollView({ render: (width) => this.renderHistory(width), invalidate() {} }, { follow: "end", scrollbar: "hidden" });
		this.viewport = { invalidate: () => this.scroll.invalidate(), render: (width) => {
			if (this.lastWidth !== width && !this.scroll.isFollowingEnd) this.restoreAnchor ??= this.anchor();
			this.lastWidth = width;
			const lines = this.scroll.render(width);
			this.scroll.updateLayout(lines.length, this.height, () => this.tui.requestRender());
			if (this.initialPosition) {
				this.initialPosition = false;
				const readIndex = this.contentItems.findIndex((item) => item.id === this.visit.readThrough);
				const unread = readIndex >= 0 ? this.contentItems[readIndex + 1] : undefined;
				this.restoreAnchor = unread ? { id: unread.id, line: 0 } : this.visit.anchor;
			}
			if (this.restoreAnchor) {
				const line = this.lines.find((line) => line.id === this.restoreAnchor?.id);
				if (line) this.scroll.scrollTo(line.start + Math.min(this.restoreAnchor.line, Math.max(0, line.end - line.start - 1)), { disableFollow: true });
				this.restoreAnchor = undefined;
			}
			const visible = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.height);
			while (visible.length < this.height) visible.push("");
			if (!this.detail) {
				this.visit.anchor = this.scroll.isFollowingEnd ? undefined : this.anchor();
				const history = this.task?.history ?? [];
				const last = this.lines.findLast((line) => line.end <= this.scroll.scrollTop + this.height && history.some((item) => item.id === line.id));
				if (last && history.findIndex((item) => item.id === last.id) > history.findIndex((item) => item.id === this.visit.readThrough)) this.visit.readThrough = last.id;
				if (this.scroll.isFollowingEnd) this.visit.seenActivityAt = this.task?.child.activity?.lastActivityAt ?? Date.now();
			}
			return visible;
		}, handleMouse: (event) => this.historyMouse(event) };
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
		if (!this.scroll.isFollowingEnd) this.restoreAnchor = this.anchor();
		this.tui.requestRender();
	}
	syncDraft(): void { if (!this.closed && this.editor.getExpandedText() !== this.visit.draft) this.editor.setText(this.visit.draft); }

	private items(): AgentHistoryItem[] {
		const task = this.task;
		if (!task) return [{ id: "unavailable", kind: "notice", title: "Agent unavailable", text: "The owning session or run is no longer available.", timestamp: 0 }];
		if (this.detail) return [this.detail];
		const assignment: AgentHistoryItem = { id: "assignment", kind: "notice", title: `Assignment · ${task.child.agent}`, text: task.child.task ?? "The original per-child assignment was not saved for this older run.", timestamp: task.run.startedAt };
		const items = [assignment, ...(task.child.state !== "live" ? [{ id: "process-exit", kind: "notice" as const, title: `Agent: ${task.child.state}`, text: formatAgentProcessExit(task.child.result?.agentProcessExit), timestamp: task.run.updatedAt }] : []), ...task.history];
		const humanAction = acceptanceHumanAction(task.child.result?.acceptance);
		if (humanAction) items.push({ id: "human-action", kind: "notice", title: "Needs your action — acceptance incomplete", text: humanAction, timestamp: task.run.updatedAt });
		if (task.unavailable) items.push({ id: "unavailable", kind: "notice", title: "Conversation unavailable", text: task.unavailable, timestamp: 0 });
		if (task.question) items.push({ id: `question:${task.question.questionId}`, kind: "notice", title: "Waiting for your answer", text: task.question.message, timestamp: task.question.createdAt });
		if (task.child.state === "live" && task.child.activity?.streamingText) items.push({ id: `live:${task.run.runId}`, kind: "assistant", title: "Agent · writing", text: task.child.activity.streamingText, timestamp: task.child.activity.lastActivityAt ?? 0 });
		for (const sent of this.visit.outbox) items.push({ id: `outgoing:${sent.id}`, kind: "user", title: sent.status === "sending" ? "You · sending" : sent.status === "waiting" ? "You · waiting for the child / tool boundary" : "You · delivery unconfirmed",
			text: `${sent.text}${sent.quote ? `\n\nRegarding ${sent.quote.title}:\n${sent.quote.text}` : ""}${sent.reason ? `\n\n${sent.reason}` : ""}`, timestamp: sent.at });
		return items;
	}

	private renderHistory(width: number): string[] {
		this.contentItems = this.items();
		this.lines = [];
		const lines: string[] = [];
		for (const item of this.contentItems) {
			const selected = item.id === this.selectedId && !this.editorFocus;
			const signature = JSON.stringify([item, selected, Boolean(this.detail)]);
			let cached = this.components.get(item.id);
			if (cached?.signature !== signature) {
				const component = new Container();
				component.addChild(new Text(this.theme.fg(selected ? "accent" : "muted", `${selected ? "› " : ""}${readableText(item.title)}`), 0, 0));
				component.addChild(item.kind === "assistant" || item.kind === "user"
					? new Markdown(item.text, 0, 0, getMarkdownTheme()) : new Text(item.text, 0, 0));
				if (item.diff) component.addChild(new Text(renderDiff(item.diff), 0, 0));
				if (this.detail && item.details) component.addChild(new Text(item.details, 0, 0));
				component.addChild(new Text("", 0, 0));
				cached = { signature, component }; this.components.set(item.id, cached);
			}
			const start = lines.length;
			lines.push(...cached.component.render(width));
			this.lines.push({ id: item.id, start, end: lines.length });
		}
		return lines;
	}

	render(width: number): string[] {
		const task = this.task;
		this.clear();
		this.addChild(new Text(this.theme.bold(truncateToWidth(`Agents › ${task?.label ?? "unavailable"}${this.detail ? " › details" : ""}`, width)), 0, 0));
		this.addChild(new Text(this.theme.fg("dim", truncateToWidth(`${task?.unread && !this.scroll.isFollowingEnd ? "New activity · Alt+L latest · " : ""}${task ? activity(task) : "Unavailable"}`, width)), 0, 0));
		if (this.menu) {
			this.addChild(this.menu);
			this.addChild(new Text("Enter Choose · Esc Back to conversation", 0, 0));
			return super.render(width);
		}
		const bottom = new Container();
		if (!this.detail) {
			if (this.visit.notice) bottom.addChild(new Text(this.theme.fg("warning", short(this.visit.notice, width)), 0, 0));
			if (this.visit.quote) bottom.addChild(new Text(this.theme.fg("dim", truncateToWidth(`Quote · Alt+Q remove: ${this.visit.quote.title}`, width)), 0, 0));
			bottom.addChild(new Text(this.theme.fg("accent", truncateToWidth(`${task?.question ? "Answer" : "Message"} ${task?.label ?? "agent"}${this.controller.isBusy(this.key) ? " · sending" : ""}`, width)), 0, 0));
			bottom.addChild(this.editor);
		}
		const terminal = task?.child.state !== "live" && !task?.question;
		const actionHint = task?.child.activity?.status === "pending" ? "Waiting to start · draft kept" : terminal ? width < 60 ? "Alt+C Continue" : "Alt+C Continue with message" : "Enter Send";
		bottom.addChild(new Text(this.theme.fg("dim", width < 60 ? `F2 Actions · Esc Back\n${actionHint} · Tab Read/write` : this.detail ? "Alt+R Reply · F2 Actions · Esc Back" : `${actionHint} · F2 Actions · Tab Read/write · Esc Back`), 0, 0));
		const fixedHeight = this.children.reduce((total, child) => total + child.render(width).length, 0) + bottom.render(width).length;
		this.height = Math.max(1, this.tui.terminal.rows - fixedHeight - 1);
		this.addChild(this.viewport); this.addChild(bottom);
		this.focused = this.hasFocus;
		return super.render(width);
	}

	handleMouse(event: TuiMouseEvent) {
		const result = super.handleMouse(event);
		if (result?.target.component === this.editor) { this.editorFocus = true; this.focused = this.hasFocus; }
		return result;
	}

	private historyMouse(event: TuiMouseEvent) {
		if (event.type === "wheel") { this.scroll.scrollBy(event.wheelDelta ?? 0); this.restoreAnchor = this.anchor(); return { handled: true }; }
		if (event.type !== "click" || event.button !== "left") return;
		this.editorFocus = false;
		this.selectedId = this.lines.find((line) => line.start <= event.y + this.scroll.scrollTop && line.end > event.y + this.scroll.scrollTop)?.id;
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
	private inspect(item: AgentHistoryItem): void {
		this.conversationAnchor = this.scroll.isFollowingEnd ? undefined : this.anchor();
		this.detail = item; this.menu = undefined; this.editorFocus = false;
		this.scroll.scrollToStart(); this.restoreAnchor = { id: item.id, line: 0 };
	}
	private reply(): void {
		const item = this.selected();
		if (!item) return;
		this.visit.quote = { title: item.title, text: [item.text, item.diff, item.details].filter(Boolean).join("\n\n") };
		this.detail = undefined; this.menu = undefined; this.editorFocus = true;
		this.restoreAnchor = this.conversationAnchor; this.controller.changed();
	}
	private actions(): void {
		const task = this.task;
		const choices = [
			{ value: "reply", label: "Reply to selected message / tool / change" },
			{ value: "details", label: "Full details / diff" },
			{ value: "changes", label: "Inspect working tree changes" },
			{ value: "latest", label: "Jump to latest activity" },
			{ value: "pin", label: this.controller.pinned === this.key ? "Unpin this agent" : "Keep this agent visible" },
			...(this.visit.quote ? [{ value: "unquote", label: "Remove quoted context" }] : []),
			...(task?.child.activity?.status === "pending" ? [] : task?.child.state === "live" || task?.question ? [{ value: "stop", label: "Stop this agent only" }] : [{ value: "continue", label: "Continue with this message" }]),
			{ value: "picker", label: "Your other agents" }, { value: "peers", label: "Other connected sessions" },
		];
		this.menu = new SelectList(choices, Math.max(1, this.tui.terminal.rows - 5), getSelectListTheme());
		this.menu.onSelect = (item) => { this.menu = undefined; this.act(item.value); };
		this.menu.onCancel = () => { this.menu = undefined; };
	}
	private act(action: string): void {
		if (action === "reply") this.reply();
		else if (action === "details") { const item = this.selected(); if (item) this.inspect(item); }
		else if (action === "changes" && !this.pendingDetail) {
			this.pendingDetail = true;
			void this.controller.changes(this.key).then((item) => { if (!this.closed && item) { this.inspect(item); this.tui.requestRender(); } })
				.catch((error) => { if (!this.closed) this.visit.notice = `Changes unavailable: ${String(error)}`; }).finally(() => { this.pendingDetail = false; });
		} else if (action === "latest") { this.restoreAnchor = undefined; this.scroll.scrollToEnd(); if (!this.editorFocus) this.selectedId = this.contentItems.at(-1)?.id; }
		else if (action === "pin") this.controller.pin(this.controller.pinned === this.key ? undefined : this.key);
		else if (action === "unquote") { this.visit.quote = undefined; this.controller.changed(); }
		else if (action === "stop") void this.controller.stop(this.key);
		else if (action === "continue") void this.controller.send(this.key, this.editor.getExpandedText(), true);
		else if (action === "picker" || action === "peers") this.finish(action);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.menu) { this.menu.handleInput(data); this.tui.requestRender(); return; }
		if (matchesKey(data, "escape")) {
			if (this.detail) { this.detail = undefined; this.editorFocus = true; this.restoreAnchor = this.conversationAnchor; if (!this.restoreAnchor) this.scroll.scrollToEnd(); }
			else this.finish();
		} else if (matchesKey(data, "f2")) this.actions();
		else if (matchesKey(data, "alt+r")) this.act("reply");
		else if (matchesKey(data, "alt+d") && (!this.editorFocus || this.detail)) this.act("details");
		else if (matchesKey(data, "alt+g")) this.act("changes");
		else if (matchesKey(data, "alt+l")) this.act("latest");
		else if (matchesKey(data, "alt+p")) this.act("pin");
		else if (matchesKey(data, "alt+q")) this.act("unquote");
		else if (matchesKey(data, "alt+s")) this.act("stop");
		else if (matchesKey(data, "alt+c")) this.act("continue");
		else if (matchesKey(data, "tab") && !this.detail) { this.editorFocus = !this.editorFocus; if (!this.editorFocus) this.select(0); }
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
	dispose(): void { this.closed = true; this.editor.onChange = undefined; this.editor.onSubmit = undefined; this.components.clear(); }
}
