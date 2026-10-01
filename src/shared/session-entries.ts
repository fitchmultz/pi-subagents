import type { SessionManager, SessionEntry } from "@earendil-works/pi-coding-agent";

type EntrySource = Pick<SessionManager, "getEntries" | "getSessionId"> & Partial<Pick<SessionManager, "getSessionFile" | "getEntry" | "getLeafId" | "getEntryCount">>;

/** Follow append-only parent links; rescan when entries were replaced or appended off the active branch. */
export class SessionEntryCursor {
	private manager?: EntrySource;
	private sessionId?: string;
	private file?: string | null;
	private known = new Map<string, SessionEntry>();
	private anchor?: SessionEntry;

	reset(): void {
		this.manager = undefined;
		this.known.clear();
		this.anchor = undefined;
	}

	read(manager: EntrySource): { entries: SessionEntry[]; reset: boolean } {
		const sessionId = manager.getSessionId(), file = manager.getSessionFile?.(), count = manager.getEntryCount?.();
		let reset = this.manager !== manager || this.sessionId !== sessionId || this.file !== file
			|| count !== undefined && count < this.known.size
			|| Boolean(this.anchor && manager.getEntry && manager.getEntry(this.anchor.id) !== this.known.get(this.anchor.id));
		let entries: SessionEntry[] | undefined;
		if (!reset && count !== undefined && manager.getEntry && manager.getLeafId) {
			const appended: SessionEntry[] = [], visited = new Set<string>();
			let id = manager.getLeafId();
			while (id && !this.known.has(id) && !visited.has(id)) {
				visited.add(id);
				const entry = manager.getEntry(id);
				if (!entry) break;
				appended.push(entry);
				id = entry.parentId;
			}
			if (count === this.known.size + appended.length && (!id || this.known.has(id))) entries = appended.reverse();
		}
		if (!entries) {
			const all = manager.getEntries();
			entries = all.filter((entry) => !this.known.has(entry.id));
			if (all.length !== this.known.size + entries.length
				|| all.some((entry) => this.known.has(entry.id) && this.known.get(entry.id) !== entry)) reset = true;
			if (reset) { this.known.clear(); entries = all; }
		}
		for (const entry of entries) this.known.set(entry.id, entry);
		this.anchor = entries.at(-1) ?? (reset ? undefined : this.anchor);
		this.manager = manager; this.sessionId = sessionId; this.file = file;
		return { entries, reset };
	}
}
