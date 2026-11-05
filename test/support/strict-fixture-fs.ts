import fs, { type ObjectEncodingOptions, type PathLike, type ReadPosition } from "node:fs";
import { mock } from "node:test";

/** Observe real native reads, preserving both readSync calling conventions. */
export function traceReadSync(
  observed: (fd: number, count: number, position: ReadPosition | null | undefined) => void,
): void {
  const read = fs.readSync;
  mock.method(
    fs,
    "readSync",
    (
      ...args:
        | Parameters<typeof fs.readSync>
        | [
            fd: number,
            buffer: NodeJS.ArrayBufferView,
            offset: number,
            length: number,
            position: ReadPosition | null,
          ]
    ) => {
      const count = args.length === 5 ? read(...args) : read(...args);
      observed(args[0], count, args.length === 5 ? args[4] : args[2]?.position);
      return count;
    },
  );
}

/** Observe real directory scans without narrowing the native encoding/Dirent API. */
export function traceReaddirSync(observed: (directory: PathLike) => void): void {
  const readdir = fs.readdirSync;
  mock.method(
    fs,
    "readdirSync",
    (
      directory: PathLike,
      options?:
        | BufferEncoding
        | "buffer"
        | null
        | (ObjectEncodingOptions & {
            withFileTypes?: false | undefined;
            recursive?: boolean | undefined;
          })
        | (ObjectEncodingOptions & { withFileTypes: true; recursive?: boolean | undefined })
        | {
            encoding: "buffer";
            withFileTypes?: false | undefined;
            recursive?: boolean | undefined;
          }
        | { encoding: "buffer"; withFileTypes: true; recursive?: boolean | undefined },
    ) => {
      let entries;
      if (options === "buffer") {
        entries = readdir(directory, options);
      } else if (typeof options === "object" && options !== null && options.encoding === "buffer") {
        entries =
          options.withFileTypes === true
            ? readdir(directory, options)
            : readdir(directory, options);
      } else if (
        typeof options === "object" &&
        options !== null &&
        options.withFileTypes === true
      ) {
        entries = readdir(directory, options);
      } else {
        entries = readdir(directory, options);
      }
      observed(directory);
      return entries;
    },
  );
}
