import { nativePeerId } from "./session-targets.ts";
import { closeSync, constants, lstatSync, opendirSync, openSync, readSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type * as NativeSession from "@earendil-works/pi-coding-agent";
import { JournalFrames } from "../shared/journal-reader.ts";
import { loadNativeSession } from "../shared/native-session-loader.ts";
import type { UnknownRecord } from "../shared/unknown.ts";
import { Fault, cancelled } from "./bridge-protocol.ts";
import type { SessionInfo } from "./types.ts";
import { resolveIntercomPresenceName } from "./identity.ts";
import { within, type LaunchPolicy } from "./bridge-launch-policy.ts";

export interface SavedSession {
  readonly sessionId: string;
  readonly peerId: string;
  readonly name?: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly lastSeen: number;
}
export interface CatalogQuery {
  readonly live: boolean;
  readonly saved: boolean;
  readonly q?: string;
  readonly offset: number;
  readonly limit: number;
}

/** Reject links at every journal path component; ordinary owned 0644 journals are valid. */
export function trustedJournal(policy: LaunchPolicy, file: string): void {
  const root = [policy.sessionDir, ...policy.resumeDirs].find((dir) => within(dir, file));
  if (root === undefined) {
    throw new Fault(403, "journal_forbidden", "Session journal is outside trusted resumeDirs.");
  }
  let path = root;
  for (const part of ["", ...relative(root, file).split(sep).filter(Boolean)]) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (!stat.isDirectory() && path !== file)
    ) {
      throw new Fault(
        403,
        "journal_forbidden",
        "Session journal must have an owned, link-free path.",
      );
    }
  }
  if (!lstatSync(file).isFile()) {
    throw new Fault(403, "journal_forbidden", "Session journal must be an owned regular file.");
  }
}
// Reads and projection input are consumed synchronously; prefix/UTF-8 carry never retains this view.
const METADATA_BYTES = Buffer.allocUnsafe(1024 * 1024);
const METADATA_FIELDS = new Set(["type", "id", "version", "timestamp", "cwd", "name", "parentId"]);
// ponytail: fast-skip native type-first envelopes only; other key ordering
// uses the bounded parser. Extend the fast path if native serialization changes.
const BODY_ENTRY =
  /^\{"type":"(?:message|model_change|thinking_level_change|compaction|branch_summary|custom|custom_message|label|usage|context_edit)",/;
class MetadataFrames {
  private prefix = Buffer.alloc(0);
  private skip: boolean | undefined;
  private readonly frames: JournalFrames;
  private readonly nativeHeader: () => boolean;
  constructor(frames: JournalFrames, nativeHeader: () => boolean) {
    this.frames = frames;
    this.nativeHeader = nativeHeader;
  }
  private part(bytes: Buffer, complete: boolean): void {
    let remainder = bytes;
    if (this.skip === undefined) {
      const count = Math.min(64 - this.prefix.length, bytes.length);
      this.prefix = Buffer.concat([this.prefix, bytes.subarray(0, count)]);
      remainder = bytes.subarray(count);
      if (this.prefix.length < 64 && !complete) {
        return;
      }
      this.skip = this.nativeHeader() && BODY_ENTRY.test(this.prefix.toString("ascii"));
      if (!this.skip) {
        this.frames.write(this.prefix);
      }
      this.prefix = Buffer.alloc(0);
    }
    if (!this.skip) {
      this.frames.write(remainder);
    }
  }
  write(bytes: Buffer): void {
    for (let from = 0; from < bytes.length;) {
      const newline = bytes.indexOf(10, from);
      const end = newline < 0 ? bytes.length : newline + 1;
      this.part(bytes.subarray(from, end), newline >= 0);
      if (newline >= 0) {
        this.skip = undefined;
      }
      from = end;
    }
  }
  finish(): void {
    if (this.prefix.length > 0) {
      this.part(Buffer.alloc(0), true);
    }
    this.frames.finish();
  }
}
async function readMetadata(
  file: string,
  sdk: typeof NativeSession,
  signal: AbortSignal,
  mode: "header" | "published" | "resume",
): Promise<Omit<SavedSession, "lastSeen">> {
  const headerOnly = mode === "header";
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata: UnknownRecord[] = [];
    let first = true;
    const frames = new JournalFrames(
      (path) => path.length === 0 || (path.length === 1 && METADATA_FIELDS.has(String(path[0]))),
      ({ value }) => {
        if (
          first &&
          (value.type !== "session" ||
            typeof value.id !== "string" ||
            typeof value.cwd !== "string")
        ) {
          throw new Error("Not a native session journal");
        }
        first = false;
        if (value.type === "session" && metadata.length === 0) {
          metadata.push(value);
        } else if (value.type === "session_info") {
          metadata[1] = value;
        }
      },
      { policy: "inspect", requireNewline: mode !== "resume" },
    );
    const bytes = headerOnly ? METADATA_BYTES.subarray(0, 64 * 1024) : METADATA_BYTES;
    const reader = new MetadataFrames(frames, () => !first);
    for (;;) {
      cancelled(signal);
      // One shared file position/buffer: reads must be serial, and yield to cancellation.
      // oxlint-disable-next-line no-await-in-loop
      await yieldTurn(undefined, { signal });
      const bytesRead = readSync(fd, bytes, 0, bytes.length, null);
      if (bytesRead === 0) {
        break;
      }
      reader.write(bytes.subarray(0, bytesRead));
      if (headerOnly && metadata.length > 0) {
        break;
      }
    }
    reader.finish();
    const header = metadata.at(0);
    if (
      header?.type !== "session" ||
      typeof header.id !== "string" ||
      typeof header.cwd !== "string"
    ) {
      throw new Error("Not a native session journal");
    }
    // Native naming and ID semantics, without opening/migrating a live journal or hydrating bodies.
    const entries = sdk.parseSessionEntries(
      metadata.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    const manager = sdk.SessionManager.inMemory(header.cwd, undefined, entries);
    return {
      sessionId: manager.getSessionId(),
      peerId: nativePeerId(manager.getSessionId()),
      name: manager.getSessionName(),
      cwd: manager.getCwd(),
      sessionFile: file,
    };
  } finally {
    closeSync(fd);
  }
}

/** Native open repairs EOF framing; inspect its identity before allowing that write. */
export function inspectResumeIdentity(
  file: string,
  sdk: typeof NativeSession,
  signal: AbortSignal,
): Promise<Pick<SavedSession, "sessionId" | "cwd" | "name">> {
  return readMetadata(file, sdk, signal, "resume");
}

export function savedView(row: SavedSession, peer?: SessionInfo): UnknownRecord {
  return {
    id: row.sessionId,
    sessionId: row.sessionId,
    peerId: peer?.id,
    name: row.name,
    cwd: row.cwd,
    status: peer?.status ?? "saved",
    lastSeen: peer?.lastSeen ?? row.lastSeen,
    saved: true,
    owned: false,
  };
}
export function exactPeer(
  row: SavedSession,
  peers: readonly SessionInfo[],
): SessionInfo | undefined {
  const expectedName = resolveIntercomPresenceName(row.name, row.sessionId);
  const peer = peers.find((candidate) => candidate.id === row.peerId);
  if (peer && (peer.cwd !== row.cwd || peer.name !== expectedName)) {
    throw new Fault(
      409,
      "active_session",
      "Native session has a live peer with changed identity; do not reopen its journal.",
    );
  }
  if (
    !peer &&
    peers.some(
      (candidate) =>
        !candidate.id.startsWith("pi-") &&
        candidate.name === expectedName &&
        candidate.cwd === row.cwd,
    )
  ) {
    throw new Fault(
      409,
      "active_session",
      "A matching live peer has unproven native identity; refusing to reopen its possible journal.",
    );
  }
  return peer;
}
interface BrowseContext {
  readonly policy?: LaunchPolicy;
  readonly signal: AbortSignal;
  readonly peers: (signal: AbortSignal) => Promise<readonly SessionInfo[]>;
  readonly activeState: (id: string) => string | undefined;
}
function liveView(peer: SessionInfo, state?: string): UnknownRecord {
  return {
    id: peer.id,
    peerId: peer.id,
    name: peer.name,
    cwd: peer.cwd,
    status: state ?? peer.status,
    lastSeen: peer.lastSeen,
    saved: false,
    owned: state !== undefined,
  };
}
export async function browseSessions(
  catalog: SessionCatalog,
  query: CatalogQuery,
  context: BrowseContext,
): Promise<UnknownRecord> {
  const peers = query.live ? await context.peers(context.signal) : [];
  const { policy } = context;
  if (query.saved && !policy) {
    throw new Fault(403, "launch_disabled", "Saved sessions require local launch/resume policy.");
  }
  const page =
    policy && query.saved
      ? await catalog.page(policy, query, context.signal)
      : { sessions: [], nextOffset: undefined };
  const rows = page.sessions.map((row) => {
    const state = context.activeState(row.sessionId);
    const peer = exactPeer(row, peers);
    return {
      ...savedView(row, peer),
      status: state ?? peer?.status ?? "saved",
      owned: state !== undefined,
    };
  });
  const included = new Set(page.sessions.map((row) => row.peerId));
  const live = peers.filter(
    (peer) =>
      !included.has(peer.id) &&
      (query.q === undefined ||
        `${peer.id} ${peer.name ?? ""} ${peer.cwd}`.toLowerCase().includes(query.q.toLowerCase())),
  );
  if (!query.saved) {
    const end = query.offset + query.limit;
    return {
      sessions: live
        .slice(query.offset, end)
        .map((peer) => liveView(peer, context.activeState(peer.id))),
      nextOffset: end < live.length ? end : undefined,
    };
  }
  return {
    sessions: [
      ...rows,
      ...live
        .slice(0, query.limit - rows.length)
        .map((peer) => liveView(peer, context.activeState(peer.id))),
    ],
    liveTruncated: rows.length + live.length > query.limit ? true : undefined,
    nextOffset: page.nextOffset,
  };
}

function uniqueSavedSession(matches: readonly SavedSession[]): SavedSession {
  if (matches.length > 1) {
    throw new Fault(
      409,
      "ambiguous_session",
      "Multiple saved sessions match; choose an exact unique native ID.",
    );
  }
  const session = matches.at(0);
  if (!session) {
    throw new Fault(
      404,
      "unknown_session",
      "No saved native session matches within trusted resumeDirs.",
    );
  }
  return session;
}

export class SessionCatalog {
  private readonly cache = new Map<
    string,
    { readonly stamp: string; readonly session: SavedSession }
  >();
  private readonly headers = new Map<
    string,
    { readonly stamp: string; readonly session: SavedSession }
  >();

  private async *walk(dir: string, signal: AbortSignal): AsyncGenerator<string> {
    await yieldTurn(undefined, { signal });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
      return;
    }
    const directory = opendirSync(dir);
    let visited = 0;
    try {
      for (let row = directory.readSync(); row !== null; row = directory.readSync()) {
        // Yield during offset skips and empty-directory traversal too.
        if (visited++ % 32 === 0) {
          // Directory entries must be processed without retaining a corpus-sized array.
          // oxlint-disable-next-line no-await-in-loop
          await yieldTurn(undefined, { signal });
        }
        cancelled(signal);
        const file = join(dir, row.name);
        if (row.isDirectory()) {
          yield* this.walk(file, signal);
        } else if (row.isFile() && row.name.endsWith(".jsonl")) {
          yield file;
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  private async *files(policy: LaunchPolicy, signal: AbortSignal): AsyncGenerator<string> {
    const unique = [...new Set([policy.sessionDir, ...policy.resumeDirs])];
    const roots = unique.filter(
      (root) => !unique.some((other) => other !== root && within(other, root)),
    );
    for (const root of roots) {
      yield* this.walk(root, signal);
    }
  }
  async read(
    policy: LaunchPolicy,
    file: string,
    signal: AbortSignal,
    headerOnly = false,
  ): Promise<SavedSession | undefined> {
    cancelled(signal);
    try {
      trustedJournal(policy, file);
      const stat = lstatSync(file);
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      const cache = headerOnly ? this.headers : this.cache;
      const cached = this.cache.get(file) ?? cache.get(file);
      if (cached?.stamp === stamp) {
        return cached.session;
      }
      const sdk = await loadNativeSession(policy.packageRoot);
      cancelled(signal);
      const session = {
        ...(await readMetadata(file, sdk, signal, headerOnly ? "header" : "published")),
        lastSeen: stat.mtimeMs,
      };
      if (cache.size >= 100000) {
        cache.clear();
      }
      cache.set(file, { stamp, session });
      return session;
    } catch (error) {
      cancelled(signal);
      if (error instanceof Fault) {
        throw error;
      }
      return undefined;
    }
  }
  async resolve(
    policy: LaunchPolicy,
    selector: { readonly sessionId?: string; readonly name?: string; readonly target?: string },
    signal: AbortSignal,
  ): Promise<SavedSession> {
    if (selector.target !== undefined) {
      return this.resolveTarget(policy, selector.target, signal);
    }
    const matches: SavedSession[] = [];
    for await (const file of this.files(policy, signal)) {
      // Inspect native metadata, not a filename/prefix guess. Yield so request cancellation can run.
      await yieldTurn(undefined, { signal });
      const row = await this.read(policy, file, signal, selector.sessionId !== undefined);
      if (
        row &&
        (selector.sessionId === undefined
          ? row.name === selector.name
          : row.sessionId === selector.sessionId || row.peerId === selector.sessionId)
      ) {
        matches.push(row);
      }
      if (matches.length > 1) {
        throw new Fault(
          409,
          "ambiguous_session",
          "Multiple saved sessions match; choose an exact unique native ID.",
        );
      }
    }
    const session = uniqueSavedSession(matches);
    return (await this.read(policy, session.sessionFile, signal)) ?? session;
  }
  private async resolveTarget(
    policy: LaunchPolicy,
    target: string,
    signal: AbortSignal,
  ): Promise<SavedSession> {
    const ids: SavedSession[] = [];
    const names: SavedSession[] = [];
    for await (const file of this.files(policy, signal)) {
      // Once an exact native ID is proven, only headers can affect its uniqueness.
      const row = await this.read(policy, file, signal, ids.length > 0);
      if (!row) {
        continue;
      }
      if ((row.sessionId === target || row.peerId === target) && ids.length < 2) {
        ids.push(row);
      }
      if (row.name === target && names.length < 2) {
        names.push(row);
      }
    }
    // Preserve exact-ID priority without paying for two complete archive scans.
    const session = uniqueSavedSession(ids.length > 0 ? ids : names);
    return (await this.read(policy, session.sessionFile, signal)) ?? session;
  }
  async page(
    policy: LaunchPolicy,
    query: CatalogQuery,
    signal: AbortSignal,
  ): Promise<{ readonly sessions: SavedSession[]; readonly nextOffset?: number }> {
    const sessions: SavedSession[] = [];
    let offset = 0;
    let scanned = 0;
    for await (const file of this.files(policy, signal)) {
      if (offset++ < query.offset) {
        continue;
      }
      if (scanned++ >= 1000 || sessions.length >= query.limit) {
        return { sessions, nextOffset: offset - 1 };
      }
      // Each bounded metadata read yields to cancellation; no whole-corpus pathname array.
      const row = await this.read(policy, file, signal);
      if (
        row &&
        (query.q === undefined ||
          `${row.sessionId} ${row.name ?? ""} ${row.cwd}`
            .toLowerCase()
            .includes(query.q.toLowerCase()))
      ) {
        sessions.push(row);
      }
    }
    return { sessions };
  }
}
