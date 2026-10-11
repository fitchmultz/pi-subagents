import * as fs from "node:fs";
import * as path from "node:path";
import { JsonProjection, readJsonProjection } from "../shared/journal-reader.ts";
import { HistoryIndexError } from "./types.ts";
import { at, object, objects } from "./values.ts";

const budget = 16 * 1024 * 1024;
function unchanged(file: string, fd: number, before: fs.BigIntStats): void {
  const after = fs.fstatSync(fd, { bigint: true });
  const current = fs.statSync(file, { bigint: true });
  if (
    before.size !== after.size ||
    before.ctimeNs !== after.ctimeNs ||
    before.dev !== current.dev ||
    before.ino !== current.ino
  ) {
    throw new HistoryIndexError("SOURCE_CHANGED", "Selected output changed; retry details.");
  }
}
export function readSavedOutput(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(budget)) {
      throw new HistoryIndexError(
        "RECORD_TOO_LARGE",
        "Selected saved output exceeds the 16 MiB detail budget.",
      );
    }
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) {
        throw new HistoryIndexError("SOURCE_CHANGED", "Selected saved output was truncated.");
      }
      offset += count;
    }
    unchanged(file, fd, before);
    return new TextDecoder("utf8", { fatal: true }).decode(bytes);
  } finally {
    fs.closeSync(fd);
  }
}
function childPrefix(file: string, index: number): readonly (string | number)[] | undefined {
  if (path.basename(file) !== "foreground.json") {
    return path.basename(file) === "result.json" ? ["results", index] : ["result"];
  }
  const metadata: unknown = readJsonProjection(
    file,
    (keys) =>
      keys.length === 0 ||
      (keys[0] === "children" && (keys.length <= 2 || (keys.length === 3 && keys[2] === "index"))),
  );
  const position = objects(object(metadata).children).findIndex((child) => child.index === index);
  return position < 0 ? undefined : ["children", position, "result"];
}
function isOutput(
  keys: readonly (string | number)[],
  prefix: readonly (string | number)[],
): boolean {
  return (
    keys.length === prefix.length + 1 &&
    prefix.every((key, position) => key === keys[position]) &&
    ["finalOutput", "output"].includes(String(keys.at(-1)))
  );
}
function outputProjection(prefix: readonly (string | number)[]): JsonProjection {
  let length = 0;
  return new JsonProjection(
    (keys) => {
      if (
        prefix[0] === "children" &&
        keys.length === 3 &&
        keys[0] === "children" &&
        keys[1] === prefix[1] &&
        keys[2] === "index"
      ) {
        return true;
      }
      if (keys.length <= prefix.length) {
        return keys.every((key, position) => key === prefix[position]);
      }
      return isOutput(keys, prefix) ? budget : false;
    },
    (keys, text) => {
      if (isOutput(keys, prefix)) {
        length += Buffer.byteLength(text);
        if (length > budget) {
          throw new HistoryIndexError(
            "RECORD_TOO_LARGE",
            "Selected canonical output exceeds the 16 MiB detail budget.",
          );
        }
      }
    },
  );
}
function readProjection(fd: number, size: number, projection: Readonly<JsonProjection>): unknown {
  const decoder = new TextDecoder("utf8", { fatal: true });
  const bytes = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < size;) {
    const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, size - offset), offset);
    if (count === 0) {
      throw new HistoryIndexError("SOURCE_CHANGED", "Selected canonical output was truncated.");
    }
    projection.write(decoder.decode(bytes.subarray(0, count), { stream: true }));
    offset += count;
  }
  projection.write(decoder.decode());
  return projection.finish();
}
/** Explicit legacy/compact owner detail: retain only this child's output, never transcript arrays. */
export function readCanonicalOutput(file: string, index: number): string | undefined {
  const prefix = childPrefix(file, index);
  if (!prefix) {
    return;
  }
  const projection = outputProjection(prefix);
  const fd = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const value = readProjection(fd, Number(before.size), projection);
    if (prefix[0] === "children" && at(value, ["children", Number(prefix[1]), "index"]) !== index) {
      throw new HistoryIndexError(
        "SOURCE_CHANGED",
        "Selected canonical child changed; retry details.",
      );
    }
    unchanged(file, fd, before);
    const result = object(at(value, prefix));
    if (typeof result.finalOutput === "string") {
      return result.finalOutput;
    }
    return typeof result.output === "string" ? result.output : undefined;
  } finally {
    fs.closeSync(fd);
  }
}
