import type { SessionManager, SessionEntry } from "@earendil-works/pi-coding-agent";
import { entryMetadata } from "./journal-reader.ts";

type EntrySource = Pick<SessionManager, "getEntries" | "getSessionId"> & Partial<Pick<SessionManager, "getSessionFile" | "getEntry" | "getLeafId">> & {
	getEntryCount?: () => number;
	getEntriesRevision?: () => number;
	getEntryMetadata?: (id: string) => unknown;
};

/** Follow append-only parent links; rescan when entries were replaced or appended off the active branch. */
export class SessionEntryCursor {
	private manager?: EntrySource;
	private sessionId?: string;
	private file?: string | null;
	private known = new Map<string, SessionEntry>();
	private anchor?: SessionEntry;
	private revision?: number;

	reset(): void {
		this.manager = undefined;
		this.known.clear();
		this.anchor = undefined;
	}

	read(manager: EntrySource): { entries: SessionEntry[]; reset: boolean } {
		const revision = manager.getEntriesRevision?.();
		// A lookup refreshes fork journals before count/leaf are inspected.
		const anchor = manager.getEntry?.(this.anchor?.id ?? manager.getLeafId?.() ?? "");
		const sessionId = manager.getSessionId(), file = manager.getSessionFile?.();
		// In-memory fork metadata is freshly projected, including an indexOf lookup.
		// Native entries themselves are stable and have no lazy journal bodies there.
		const metadata = Boolean(file && manager.getEntryMetadata && manager.getEntry);
		const get = (id: string) => (metadata ? manager.getEntryMetadata!(id) : manager.getEntry?.(id)) as SessionEntry | undefined;
		const count = manager.getEntryCount?.();
		let reset = this.manager !== manager || this.sessionId !== sessionId || this.file !== file
			|| count !== undefined && count < this.known.size
			|| Boolean(this.anchor && manager.getEntry && anchor !== this.known.get(this.anchor.id));
		let entries: SessionEntry[] | undefined;
		let rawEntries: SessionEntry[] | undefined;
		if (!reset && count !== undefined && manager.getEntry && manager.getLeafId) {
			const appended: SessionEntry[] = [];
			const visited = new Set<string>();
			let id = manager.getLeafId();
			while (id && !this.known.has(id) && !visited.has(id)) {
				visited.add(id);
				const entry = get(id);
				if (!entry) break;
				appended.push(entry);
				id = entry.parentId;
			}
			const sequence = (entry: SessionEntry) => (entry as SessionEntry & { sequence?: number }).sequence;
			const suffix = appended.reverse();
			const contiguous = this.anchor && sequence(this.anchor) !== undefined
				? suffix.every((entry, index) => sequence(entry) === sequence(this.anchor!)! + index + 1) : true;
			if (count === this.known.size + suffix.length && (!id || this.known.has(id)) && contiguous
				&& (revision === undefined || this.revision !== undefined && revision - this.revision === suffix.length)) entries = suffix;
		}
		if (!entries) {
			// getEntries returns stable native references without hydrating lazy bodies.
			// One bulk read avoids a journal filesystem refresh for every historical ID.
			const all = manager.getEntries();
			entries = all.filter((entry) => !this.known.has(entry.id));
			if (all.length !== this.known.size + entries.length
				|| all.some((entry) => this.known.has(entry.id) && this.known.get(entry.id) !== entry)) reset = true;
			if (reset) this.known.clear();
			if (reset) entries = all;
			rawEntries = entries;
			if (metadata && entries.length) {
				const ids = new Set(entries.map((entry) => entry.id));
				entries = [...entryMetadata(manager)].filter((entry) => ids.has(entry.id));
			}
		}
		for (const entry of rawEntries ?? entries) this.known.set(entry.id, rawEntries || !metadata ? entry : manager.getEntry!(entry.id)!);
		this.anchor = entries.at(-1) ?? (reset ? undefined : this.anchor);
		this.manager = manager;
		this.sessionId = sessionId;
		this.file = file;
		this.revision = revision;
		return { entries, reset };
	}
}
