import { createHash, type Hash } from "node:crypto";
import * as fs from "node:fs";
import {
  journalStamp,
  scanJournal,
  type JournalPolicy,
  type Projection,
} from "../../shared/journal-reader.ts";
import type { ObservedUsage } from "../../shared/types.ts";
import { isObject, nonempty } from "./child-json.ts";
import { observedUsage, optionalString, requiredString } from "./child-message-validation.ts";

export type ParentReceipt =
  | {
      readonly type: "custom_message";
      readonly id: string;
      readonly timestamp?: string;
      readonly customType?: string;
      readonly details?: unknown;
    }
  | {
      readonly type: "message";
      readonly id: string;
      readonly timestamp?: string;
      readonly message: {
        readonly role: "toolResult";
        readonly toolName: string;
        readonly usage?: ObservedUsage;
        readonly details?: unknown;
      };
    };
export interface ParentReceiptReader {
  readonly clear: () => void;
  readonly read: (file: string | undefined) => ReadonlyMap<string, ParentReceipt>;
}
interface ReceiptCache {
  readonly file: string;
  readonly identity: string;
  readonly end: number;
  readonly digest: string;
  readonly records: Readonly<ReadonlyMap<string, ParentReceipt>>;
}

function hashRange(fd: number, start: number, end: number, hash: Hash): void {
  const bytes = Buffer.allocUnsafe(64 * 1024);
  let position = start;
  while (position < end) {
    const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, end - position), position);
    if (count === 0) {
      throw new Error("Parent journal truncated during inspection");
    }
    hash.update(bytes.subarray(0, count));
    position += count;
  }
}
const receiptProjection: Projection = (keys) => {
  if (keys.length === 0 || ["type", "id", "timestamp", "customType"].includes(String(keys[0]))) {
    return true;
  }
  if (keys[0] === "details") {
    return projectedReceiptDetails(keys);
  }
  if (keys[0] === "message") {
    return projectedReceiptMessage(keys);
  }
  return false;
};

function projectedReceiptDetails(keys: readonly (string | number)[]): boolean {
  return (
    keys.length === 1 ||
    (["completion", "subagentCompletion", "result"].includes(String(keys[1])) &&
      (keys[1] !== "result" || keys.length <= 3 || keys[3] === "wait"))
  );
}
function projectedReceiptMessage(keys: readonly (string | number)[]): boolean {
  return (
    keys.length === 1 ||
    ["role", "toolName", "usage"].includes(String(keys[1])) ||
    (keys[1] === "details" &&
      (keys.length === 2 || ["wait", "parentUsage"].includes(String(keys[2]))))
  );
}

function parseReceipt(value: Readonly<Record<string, unknown>>): ParentReceipt | undefined {
  if (value.type === "custom_message") {
    return {
      ...value,
      type: "custom_message",
      id: requiredString(value.id, "receipt ID"),
      timestamp: optionalString(value.timestamp, "timestamp"),
      customType: optionalString(value.customType, "customType"),
    };
  }
  if (value.type !== "message" || !isObject(value.message) || value.message.role !== "toolResult") {
    return;
  }
  return {
    ...value,
    type: "message",
    id: requiredString(value.id, "receipt ID"),
    timestamp: optionalString(value.timestamp, "timestamp"),
    message: {
      ...value.message,
      role: "toolResult",
      toolName: requiredString(value.message.toolName, "toolName"),
      usage: observedUsage(value.message.usage),
    },
  };
}

function verifiedPrefix(
  fd: number,
  location: { readonly file: string; readonly identity: string; readonly size: number },
  cache: ReceiptCache | undefined,
): { hash: Hash; previous?: ReceiptCache } {
  const hash = createHash("sha256");
  if (
    !cache ||
    cache.file !== location.file ||
    cache.identity !== location.identity ||
    location.size < cache.end
  ) {
    return { hash };
  }
  // Coarse timestamps can hide same-size edits; stat hits still require verified bytes.
  hashRange(fd, 0, cache.end, hash);
  return hash.copy().digest("hex") === cache.digest
    ? { hash, previous: cache }
    : { hash: createHash("sha256") };
}

/** Cache only LF-published receipt fields, never transcripts or accepted-but-unsaved messages. */
export function createParentReceiptReader(policy: JournalPolicy): ParentReceiptReader {
  let cache: ReceiptCache | undefined;
  return {
    clear() {
      cache = undefined;
    },
    read(file) {
      if (!nonempty(file) || !fs.existsSync(file)) {
        cache = undefined;
        return new Map();
      }
      const fd = fs.openSync(file, "r");
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        const stamp = journalStamp(stat);
        const identity = `${stat.dev}:${stat.ino}`;
        const { hash, previous } = verifiedPrefix(
          fd,
          { file, identity, size: Number(stat.size) },
          cache,
        );
        if (previous && Number(stat.size) === previous.end) {
          if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== stamp) {
            throw new Error("Parent journal changed during inspection");
          }
          return previous.records;
        }
        const start = previous?.end ?? 0;
        const records = new Map(previous?.records);
        const end = scanJournal(
          fd,
          receiptProjection,
          ({ value }) => {
            const receipt = parseReceipt(value);
            if (receipt) {
              records.set(receipt.id, receipt);
            }
          },
          { policy, requireNewline: true, start, end: Number(stat.size) },
        );
        hashRange(fd, start, end, hash);
        if (journalStamp(fs.fstatSync(fd, { bigint: true })) !== stamp) {
          throw new Error("Parent journal changed during inspection");
        }
        cache = { file, identity, end, digest: hash.digest("hex"), records };
        return records;
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}
