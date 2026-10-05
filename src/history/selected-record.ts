import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { JsonProjection } from "../shared/journal-reader.ts";
import { HistoryIndexError } from "./types.ts";
import type { EntryRow, SourceRow } from "./rows.ts";
import { identity } from "./source-file.ts";
import { previewLimits, previewProjection } from "./preview.ts";
import { parseObject, isObject, errorCode } from "./values.ts";

function validateHeader(fd: number, source: SourceRow): void {
  const hash = createHash("sha256");
  const bytes = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  let complete = false;
  while (!complete && position < 1024 * 1024) {
    const count = fs.readSync(fd, bytes, 0, bytes.length, position);
    if (count === 0) {
      break;
    }
    const newline = bytes.subarray(0, count).indexOf(10);
    const length = newline < 0 ? count : newline + 1;
    hash.update(bytes.subarray(0, length));
    position += length;
    complete = newline >= 0;
  }
  if (!complete || hash.digest("hex") !== source.header_digest) {
    throw new HistoryIndexError(
      "SOURCE_CHANGED",
      "Selected native header changed or exceeds its validation budget.",
    );
  }
}
function readBody(
  fd: number,
  row: EntryRow,
  full: boolean,
): { readonly value: Readonly<Record<string, unknown>>; readonly digest: string } {
  const digest = createHash("sha256");
  const parser = new JsonProjection(previewProjection, undefined, undefined, previewLimits);
  const bytes = Buffer.allocUnsafe(64 * 1024);
  const body: Buffer[] = [];
  const decoder = new TextDecoder("utf8", { fatal: true });
  for (let position = row.start; position < row.end;) {
    const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, row.end - position), position);
    if (count === 0) {
      throw new HistoryIndexError(
        "SOURCE_CHANGED",
        "Selected record was truncated during validation.",
      );
    }
    const chunk = bytes.subarray(0, count);
    digest.update(chunk);
    if (full) {
      body.push(Buffer.from(chunk));
    } else {
      parser.write(decoder.decode(chunk, { stream: true }));
    }
    position += count;
  }
  let value: Readonly<Record<string, unknown>>;
  if (full) {
    value = parseObject(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(body)));
  } else {
    parser.write(decoder.decode());
    const projected = parser.finish();
    if (!isObject(projected)) {
      throw new HistoryIndexError("SOURCE_CHANGED", "Selected record is not an object.");
    }
    value = projected;
  }
  return { value, digest: digest.digest("hex") };
}
function validateSnapshot(
  fd: number,
  source: SourceRow,
  row: EntryRow,
  snapshot: { readonly before: fs.BigIntStats; readonly digest: string },
): void {
  const { before, digest } = snapshot;
  const current = fs.statSync(source.path, { bigint: true });
  const after = fs.fstatSync(fd, { bigint: true });
  if (
    identity(current) !== identity(before) ||
    current.size < BigInt(row.end) ||
    (after.ctimeNs !== before.ctimeNs && after.size <= before.size) ||
    digest !== row.digest
  ) {
    throw new HistoryIndexError(
      "SOURCE_CHANGED",
      "Selected record changed; refresh history before reading details.",
    );
  }
}
/** Revalidate physical identity, native header and exact selected bytes before exposing detail. */
export function validateRecord(
  source: SourceRow,
  row: EntryRow,
  full: boolean,
): Readonly<Record<string, unknown>> {
  let fd: number | undefined;
  try {
    fd = fs.openSync(source.path, "r");
    const stat = fs.fstatSync(fd, { bigint: true });
    if (identity(stat) !== source.identity || Number(stat.size) < row.end) {
      throw new HistoryIndexError(
        "SOURCE_CHANGED",
        "Selected conversation was replaced or truncated.",
      );
    }
    validateHeader(fd, source);
    if (full && row.end - row.start > 16 * 1024 * 1024) {
      throw new HistoryIndexError(
        "RECORD_TOO_LARGE",
        "Selected full record exceeds the 16 MiB detail budget; use its validated preview.",
      );
    }
    const body = readBody(fd, row, full);
    validateSnapshot(fd, source, row, { before: stat, digest: body.digest });
    return body.value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new HistoryIndexError("SOURCE_CHANGED", "Selected conversation is missing.");
    }
    if (error instanceof RangeError) {
      throw new HistoryIndexError(
        "RECORD_COMPLEXITY",
        "Selected preview exceeds bounded history structure budgets.",
      );
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}
