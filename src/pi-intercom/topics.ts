import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { isTopicSubscription, isTopicUpdate, type Message, type SessionInfo, type TopicSubscription, type TopicUpdate } from "./types.ts";

interface TopicRecord { from: Pick<SessionInfo, "id" | "name">; update: TopicUpdate; connected: boolean; notifiedRevision?: number }
const TOPIC_ENTRY = "intercom-topic";

/** Latest inspectable state plus native audit entries; routine updates never enter model context. */
export class IntercomTopics {
	private pi: ExtensionAPI;
	private getContext: () => ExtensionContext | null;
	private records = new Map<string, TopicRecord>();
	private disconnectedOwners = new Set<string>();
	private render?: () => void;
	private hydrate = new Set<string>();
	readonly subscriptions = new Map<string, TopicSubscription>();
	readonly published = new Map<string, TopicUpdate>();
	constructor(pi: ExtensionAPI, getContext: () => ExtensionContext | null) { this.pi = pi; this.getContext = getContext; }

	private save(data: object): void {
		const ctx = this.getContext();
		if (ctx) this.pi.appendEntry(TOPIC_ENTRY, { sessionId: ctx.sessionManager.getSessionId(), ...data });
	}
	start(ctx: ExtensionContext): void {
		this.render = undefined;
		this.records.clear(); this.disconnectedOwners.clear(); this.hydrate.clear(); this.subscriptions.clear(); this.published.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== TOPIC_ENTRY) continue;
			const data = entry.data as { sessionId?: string; subscriptions?: TopicSubscription[]; published?: TopicUpdate; record?: TopicRecord };
			if (data?.sessionId !== ctx.sessionManager.getSessionId()) continue;
			if (Array.isArray(data.subscriptions) && data.subscriptions.every(isTopicSubscription)) {
				this.subscriptions.clear(); for (const subscription of data.subscriptions) this.subscriptions.set(subscription.topic, subscription);
			}
			if (isTopicUpdate(data.published)) this.published.set(data.published.topic, data.published);
			if (data.record && isTopicUpdate(data.record.update)) this.records.set(`${data.record.from.id}:${data.record.update.topic}`, { ...data.record, connected: false });
		}
		for (const topic of this.subscriptions.keys()) this.hydrate.add(topic);
		this.renderOwner();
	}
	subscribe(topic: string, awaitRelease?: boolean): void {
		this.subscriptions.set(topic, { topic, ...(awaitRelease ? { awaitRelease } : {}) });
		this.hydrate.add(topic);
		this.save({ subscriptions: [...this.subscriptions.values()] });
	}
	unsubscribe(topic: string): void { this.subscriptions.delete(topic); this.save({ subscriptions: [...this.subscriptions.values()] }); }
	publish(update: TopicUpdate, from: Pick<SessionInfo, "id" | "name">): void { this.published.set(update.topic, update); this.save({ published: update }); this.record(from, update); }
	presence(): Pick<SessionInfo, "subscriptions" | "topics"> { return { subscriptions: [...this.subscriptions.values()], topics: [...this.published.values()] }; }
	private record(from: Pick<SessionInfo, "id" | "name">, update: TopicUpdate, connected = true): boolean {
		const key = `${from.id}:${update.topic}`, previous = this.records.get(key);
		if (previous && previous.update.revision >= update.revision) return false;
		const record = { from: { id: from.id, name: from.name }, update, connected: connected && !this.disconnectedOwners.has(from.id), notifiedRevision: previous?.notifiedRevision };
		this.records.set(key, record); this.save({ record }); this.renderOwner(); this.render?.();
		return true;
	}
	/** True means handled as quiet state (or unsubscribed/obsolete), not a conversation message. */
	receive(from: SessionInfo, message: Message): boolean {
		const update = message.topic;
		if (!update) return false;
		const subscription = this.subscriptions.get(update.topic);
		if (!subscription) return true;
		const key = `${from.id}:${update.topic}`;
		if ((this.records.get(key)?.update.revision ?? 0) > update.revision) return true;
		this.record(from, update);
		if (update.event === "update" || update.event === "release" && !subscription.awaitRelease) return true;
		const record = this.records.get(key)!;
		if ((record.notifiedRevision ?? 0) >= update.revision) return true;
		record.notifiedRevision = update.revision;
		this.save({ record });
		return false;
	}
	refresh(sessions: SessionInfo[]): void {
		for (const session of sessions) this.disconnectedOwners.delete(session.id);
		for (const record of this.records.values()) record.connected = sessions.some((session) => session.id === record.from.id);
		for (const session of sessions) for (const update of session.topics ?? []) {
			if (this.subscriptions.has(update.topic)) {
				this.record(session, update);
				const record = this.records.get(`${session.id}:${update.topic}`)!;
				if (this.hydrate.has(update.topic) && (record.notifiedRevision ?? 0) < update.revision) {
					record.notifiedRevision = update.revision; this.save({ record });
				}
			}
		}
		this.hydrate.clear();
		this.renderOwner();
	}
	disconnected(id?: string): void {
		if (id) this.disconnectedOwners.add(id);
		for (const record of this.records.values()) if (!id || record.from.id === id) { record.connected = false; this.disconnectedOwners.add(record.from.id); }
		this.renderOwner(); this.render?.();
	}
	private renderOwner(): void {
		const ctx = this.getContext();
		if (ctx?.mode !== "tui") return;
		const owners = [...this.records.values()].filter((record) => record.update.resource && record.update.ownership);
		const current = owners.sort((a, b) => b.update.updatedAt - a.update.updatedAt)[0];
		ctx.ui.setStatus("intercom-owner", current ? truncateToWidth(`${current.update.resource}: ${current.from.name ?? current.from.id} · ${current.update.ownership === "released" ? "released" : current.connected ? "held" : "disconnected (not released)"}${owners.length > 1 ? ` · +${owners.length - 1}` : ""} · /intercom topics`, 110) : undefined);
	}
	inspect(topic?: string): string {
		const subscriptions = [...this.subscriptions.values()].filter((item) => !topic || item.topic === topic);
		const records = [...this.records.values()].filter((record) => !topic || record.update.topic === topic).sort((a, b) => b.update.updatedAt - a.update.updatedAt);
		return ["Intercom topics · latest self-contained state (not a work queue or exclusive lock)",
			`Subscriptions: ${subscriptions.map((item) => `${item.topic}${item.awaitRelease ? " (awaiting release)" : ""}`).join(", ") || "none"}`,
			...records.map(({ from, update, connected }) => `\n${update.topic} · ${from.name ?? from.id} · ${connected ? "connected" : "disconnected / unavailable"}\n${update.resource ? `Resource: ${update.resource} · declared ${update.ownership ?? "state unknown"}${!connected && update.ownership !== "released" ? "; disconnect is not release" : ""}\n` : ""}${new Date(update.updatedAt).toISOString()} · ${update.event}\n${update.text}`),
			...(!records.length ? ["No current records. Subscribe to an exact topic or publish a self-contained update."] : []),
		].join("\n");
	}
	async open(ctx: ExtensionContext, notice?: string): Promise<void> {
		await ctx.ui.custom((tui, _theme, _keys, done) => {
			const text = new Text("", 0, 0);
			const scroll = new ScrollView(text, { follow: "none", scrollbar: "hidden" });
			const render = () => tui.requestRender();
			this.render = render;
			return {
				invalidate() { scroll.invalidate(); },
				dispose: () => { if (this.render === render) this.render = undefined; },
				render: (width) => { text.setText([notice, this.inspect()].filter(Boolean).join("\n\n")); const lines = scroll.render(width); const height = Math.max(1, tui.terminal.rows - 2); scroll.updateLayout(lines.length, height, () => tui.requestRender()); return [...lines.slice(scroll.scrollTop, scroll.scrollTop + height), truncateToWidth("↑/↓ PgUp/PgDn Read · Esc Back", width)]; },
				handleInput(data) { if (matchesKey(data, "escape")) done(undefined); else { scroll.scrollBy(matchesKey(data, "pageUp") ? -scroll.viewportHeight : matchesKey(data, "pageDown") ? scroll.viewportHeight : matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0); tui.requestRender(); } },
				handleMouse(event) { if (event.type === "wheel") { scroll.scrollBy(event.wheelDelta ?? 0); return { handled: true }; } },
			};
		}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } });
	}
}
