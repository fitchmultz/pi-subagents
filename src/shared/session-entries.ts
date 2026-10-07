import type { SessionManager, SessionEntry } from "@earendil-works/pi-coding-agent";

type EntrySource = Pick<SessionManager, "getEntries" | "getSessionId"> &
  Partial<Pick<SessionManager, "getSessionFile" | "getEntry" | "getLeafId" | "getEntryCount">>;
interface Snapshot {
  readonly manager: EntrySource;
  readonly sessionId: string;
  readonly file: string | null | undefined;
  readonly count: number | undefined;
}

/** Follow append-only parent links; rescan after replacement or append off the active branch. */
export class SessionEntryCursor {
  private manager?: EntrySource;
  private sessionId?: string;
  private file?: string | null;
  private readonly known = new Map<string, SessionEntry>();
  private anchor?: SessionEntry;
  reset(): void {
    this.manager = undefined;
    this.known.clear();
    this.anchor = undefined;
  }
  private changed(snapshot: Snapshot): boolean {
    if (
      this.manager !== snapshot.manager ||
      this.sessionId !== snapshot.sessionId ||
      this.file !== snapshot.file
    ) {
      return true;
    }
    if (snapshot.count !== undefined && snapshot.count < this.known.size) {
      return true;
    }
    return (
      this.anchor !== undefined &&
      snapshot.manager.getEntry !== undefined &&
      snapshot.manager.getEntry(this.anchor.id) !== this.known.get(this.anchor.id)
    );
  }
  private appendedBranch(
    manager: EntrySource,
  ): { entries: SessionEntry[]; tail: string | null } | undefined {
    if (manager.getEntry === undefined || manager.getLeafId === undefined) {
      return undefined;
    }
    const entries: SessionEntry[] = [];
    const visited = new Set<string>();
    let id = manager.getLeafId();
    while (id !== null && id !== "" && !this.known.has(id) && !visited.has(id)) {
      visited.add(id);
      const entry = manager.getEntry(id);
      if (!entry) {
        break;
      }
      entries.push(entry);
      id = entry.parentId;
    }
    return { entries, tail: id };
  }
  private appended(snapshot: Snapshot): SessionEntry[] | undefined {
    if (snapshot.count === undefined) {
      return undefined;
    }
    const branch = this.appendedBranch(snapshot.manager);
    if (!branch) {
      return undefined;
    }
    const { entries, tail } = branch;
    const connects = tail === null || tail === "" || this.known.has(tail);
    return snapshot.count === this.known.size + entries.length && connects
      ? entries.reverse()
      : undefined;
  }
  private rescan(
    manager: EntrySource,
    reset: boolean,
  ): { entries: SessionEntry[]; reset: boolean } {
    const all = manager.getEntries();
    const added = all.filter((entry) => !this.known.has(entry.id));
    const replaced =
      all.length !== this.known.size + added.length ||
      all.some((entry) => this.known.has(entry.id) && this.known.get(entry.id) !== entry);
    return { entries: reset || replaced ? all : added, reset: reset || replaced };
  }
  read(manager: EntrySource): { entries: SessionEntry[]; reset: boolean } {
    const snapshot: Snapshot = {
      manager,
      sessionId: manager.getSessionId(),
      file: manager.getSessionFile?.(),
      count: manager.getEntryCount?.(),
    };
    const changed = this.changed(snapshot);
    const appended = changed ? undefined : this.appended(snapshot);
    const result = appended ? { entries: appended, reset: false } : this.rescan(manager, changed);
    if (result.reset) {
      this.known.clear();
    }
    for (const entry of result.entries) {
      this.known.set(entry.id, entry);
    }
    this.anchor = result.entries.at(-1) ?? (result.reset ? undefined : this.anchor);
    this.manager = manager;
    this.sessionId = snapshot.sessionId;
    this.file = snapshot.file;
    return result;
  }
}
