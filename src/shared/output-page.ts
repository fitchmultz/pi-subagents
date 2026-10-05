import * as fs from "node:fs";
interface OutputPageOptions {
  readonly offset?: number;
  readonly length?: number;
}
function pageLength(options: OutputPageOptions): number {
  const length = options.length ?? 64 * 1024;
  if (!Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) {
    throw new Error("Invalid output page");
  }
  if (
    options.offset !== undefined &&
    (!Number.isSafeInteger(options.offset) || options.offset < 0)
  ) {
    throw new Error("Invalid output page");
  }
  return length;
}
function width(lead: number): number {
  if (lead < 0x80) {
    return 1;
  }
  if (lead < 0xe0) {
    return 2;
  }
  return lead < 0xf0 ? 3 : 4;
}
function continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
function utf8Bounds(bytes: Buffer, count: number, more: boolean): { start: number; end: number } {
  let start = 0;
  let end = count;
  while (start < end && continuation(bytes[start])) {
    start++;
  }
  if (more && end > start) {
    let last = end - 1;
    while (last >= start && continuation(bytes[last])) {
      last--;
    }
    const lead = bytes[last];
    if (last + width(lead) > end) {
      end = last;
    }
  }
  return { start, end };
}
/** Read a UTF-8 page or tail without reading its preceding output. */
export function readOutputPage(
  file: string,
  options: OutputPageOptions = {},
): {
  text: string;
  offset: number;
  nextOffset?: number;
  size: number;
} {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = pageLength(options);
    const offset = Math.min(size, options.offset ?? Math.max(0, size - length));
    const bytes = Buffer.alloc(Math.min(length, size - offset));
    const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
    const { start, end } = utf8Bounds(bytes, count, offset + count < size);
    return {
      text: bytes.subarray(start, end).toString("utf8"),
      offset: offset + start,
      size,
      ...(offset + end < size ? { nextOffset: offset + end } : {}),
    };
  } finally {
    fs.closeSync(fd);
  }
}
