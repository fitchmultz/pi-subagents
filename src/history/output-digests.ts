import * as fs from "node:fs";
import type { HistoryRunRow } from "./types.ts";
import { exactTextDigest } from "./text.ts";
import { readSavedOutput } from "./canonical-result.ts";

/** Cached by physical file snapshot; compact/possibly truncated previews never become exact matches. */
export class OutputDigests {
  private readonly cached = new Map<string, { readonly stamp: string; readonly digest: string }>();
  read(result: HistoryRunRow["children"][number]["result"]): string | null {
    if (!result) {
      return null;
    }
    if (result.fullOutputPath === undefined || result.fullOutputPath.length === 0) {
      return typeof result.finalOutput === "string" &&
        result.finalOutput.length !== 8192 &&
        result.truncation?.truncated !== true
        ? exactTextDigest(result.finalOutput)
        : null;
    }
    return this.fileDigest(result.fullOutputPath);
  }
  private fileDigest(file: string): string | null {
    try {
      const stat = fs.statSync(file, { bigint: true });
      if (!stat.isFile() || stat.size > 16n * 1024n * 1024n) {
        return null;
      }
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      const cached = this.cached.get(file);
      if (cached?.stamp === stamp) {
        return cached.digest;
      }
      const digest = exactTextDigest(readSavedOutput(file));
      this.cached.set(file, { stamp, digest });
      return digest;
    } catch {
      // An unavailable canonical file has no exact fingerprint; never fall back to its preview.
      return null;
    }
  }
}
