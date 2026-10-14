import { constants, openSync, closeSync, fstatSync } from "node:fs";
import type * as NativeSession from "@earendil-works/pi-coding-agent";
import { loadNativeSession } from "../shared/native-session-loader.ts";
import { scanJournal, type Projection } from "../shared/journal-reader.ts";
import { Fault } from "./bridge-protocol.ts";
import { readLiveTranscript, type TranscriptOptions, type TranscriptPage } from "./transcript.ts";

const FILE_BYTES = 64 * 1024 * 1024;
const ENTRY_COUNT = 50000;
const TEXT_LIMIT = 131072;
const fields = new Set([
  "type",
  "id",
  "parentId",
  "timestamp",
  "version",
  "cwd",
  "customType",
  "display",
  "content",
]);
/** Only branch structure and public textual content are hydrated, never image/provider/custom data. */
const transcriptProjection: Projection = (path) => {
  if (path.length === 0) {
    return true;
  }
  if (path[0] === "message") {
    return messageField(path.slice(1));
  }
  if (path[0] === "content") {
    return contentField(path.slice(1));
  }
  return path.length === 1 && fields.has(String(path[0])) ? 4096 : false;
};
function messageField(path: readonly (string | number)[]): boolean | number {
  if (path.length === 0) {
    return true;
  }
  if (path[0] === "content") {
    return contentField(path.slice(1));
  }
  return path.length === 1 && ["role", "output", "display", "truncated"].includes(String(path[0]))
    ? TEXT_LIMIT
    : false;
}
function contentField(path: readonly (string | number)[]): boolean | number {
  return path.length < 2 || (path.length === 2 && ["type", "text"].includes(String(path[1])))
    ? TEXT_LIMIT
    : false;
}
function textField(path: readonly (string | number)[]): boolean {
  if (path[0] === "message") {
    return (
      (path.length === 2 && ["content", "output"].includes(String(path[1]))) ||
      (path.length === 4 && path[1] === "content" && path[3] === "text")
    );
  }
  return path[0] === "content" && (path.length === 1 || (path.length === 3 && path[2] === "text"));
}
function savedLines(
  fd: number,
  size: number,
): { readonly lines: readonly string[]; readonly cut: ReadonlySet<number> } {
  const lines: string[] = [];
  const cut = new Set<number>();
  const lengths = new Map<string, number>();
  scanJournal(
    fd,
    transcriptProjection,
    ({ value }) => {
      if (lines.length >= ENTRY_COUNT) {
        throw new Fault(
          413,
          "transcript_too_large",
          "Saved journal exceeds the 50000-entry budget.",
        );
      }
      lines.push(JSON.stringify(value));
      lengths.clear();
    },
    {
      policy: "inspect",
      requireNewline: true,
      end: size,
      limits: { depth: 64, nodes: 16384, arrayLength: 4096, keyLength: 512 },
      malformed: (_start, _end, error) => {
        if (error instanceof RangeError) {
          throw new Fault(413, "transcript_too_large", "Saved record exceeds projection limits.");
        }
        lengths.clear();
        cut.delete(lines.length);
      },
      stringChunk: (path, chunk) => {
        if (textField(path)) {
          const key = JSON.stringify(path);
          const count = (lengths.get(key) ?? 0) + chunk.length;
          lengths.set(key, count);
          if (count > TEXT_LIMIT) {
            cut.add(lines.length);
          }
        }
      },
    },
  );
  return { lines, cut };
}
/** Internal hook: caller MUST resolve a catalog-approved saved ID/name, never accept an HTTP filepath. */
export async function readSavedTranscript(
  packageRoot: string,
  approvedFile: string,
  options: TranscriptOptions = {},
): Promise<TranscriptPage> {
  const sdk = await loadNativeSession(packageRoot);
  const fd = openSync(approvedFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > FILE_BYTES) {
      throw new Fault(413, "transcript_too_large", "Saved journal exceeds the 64 MiB read budget.");
    }
    const { lines, cut } = savedLines(fd, before.size);
    const after = fstatSync(fd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Fault(
        409,
        "session_changed",
        "Saved journal changed during reading; refresh the catalog.",
      );
    }
    const entries = sdk.parseSessionEntries(lines.join("\n"));
    return savedPage(entries, cut, options, sdk);
  } finally {
    closeSync(fd);
  }
}
function savedPage(
  entries: ReturnType<typeof NativeSession.parseSessionEntries>,
  cut: ReadonlySet<number>,
  options: TranscriptOptions,
  sdk: typeof NativeSession,
): TranscriptPage {
  const header = entries.find((entry) => entry.type === "session");
  if (header === undefined) {
    throw new Fault(409, "invalid_session", "Saved journal has no native session header.");
  }
  const legacy = (header.version ?? 1) < 2;
  if (legacy && options.cursor !== undefined) {
    throw new Fault(
      409,
      "cursor_unavailable",
      "Legacy journals have no stable entry IDs; request a fresh bounded recent transcript.",
    );
  }
  // Native inMemory reconstructs branch state/migrations without ever opening or writing the file.
  const manager = sdk.SessionManager.inMemory(header.cwd, undefined, entries);
  const page = readLiveTranscript(manager, options);
  const cutIds = new Set(
    entries.flatMap((entry, index) =>
      entry.type !== "session" && cut.has(index) ? [entry.id] : [],
    ),
  );
  const records = page.records.map((entry) =>
    cutIds.has(entry.id) ? { ...entry, truncated: true } : entry,
  );
  return {
    ...page,
    // ponytail: v1 has no persisted entry IDs; use catalog snapshot cursors if legacy pagination is needed.
    cursor: legacy ? undefined : page.cursor,
    records,
    truncated: page.truncated || records.some((entry) => entry.truncated),
  };
}
