import { realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, resolve } from "node:path";
import { assertRecord, readJson } from "./assertions.ts";

/** A static SDK import must execute the graph selected by the qualification owner. */
export function nativeSdkRoot(requested?: string): string {
  const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
  if (manifest === undefined) {
    throw new Error("The test's installed Pi SDK package could not be resolved.");
  }
  const installed = realpathSync(dirname(manifest));
  if (requested !== undefined && realpathSync(requested) !== installed) {
    throw new Error(
      `Native test SDK mismatch: requested ${requested}, installed ${installed}. Run in the selected host's isolated dependency graph.`,
    );
  }
  return installed;
}

/** Read the selected package's actual CLI entry instead of assuming a dist layout. */
export function nativeCli(root = nativeSdkRoot()): string {
  const manifest = readJson(resolve(root, "package.json"));
  assertRecord(manifest);
  assertRecord(manifest.bin);
  if (typeof manifest.bin.pi !== "string") {
    throw new Error(`Native SDK ${root} does not declare its Pi CLI.`);
  }
  return resolve(root, manifest.bin.pi);
}
