import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

interface ReadObservation {
  readonly count: number;
  readonly length: number;
  readonly position: number | bigint | null;
}

/** These journal readers use the positional Buffer overload; preserve native I/O and observe it. */
export function observeReads(t: TestContext, observe: (read: ReadObservation) => void): void {
  const read = fs.readSync;
  t.mock.method(
    fs,
    "readSync",
    (
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | bigint | null,
    ) => {
      const count = read(fd, buffer, { offset, length, position });
      observe({ count, length, position });
      return count;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}
