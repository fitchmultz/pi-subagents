import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as NativeAI from "@earendil-works/pi-ai";

/** Resolve companion values from the caller-selected SDK, not the fixture's development graph. */
export async function loadNativeAI(sdkRoot: string): Promise<typeof NativeAI> {
  const entry = pathToFileURL(join(sdkRoot, "dist/index.js"));
  const manifest = findPackageJSON("@earendil-works/pi-ai", entry);
  if (manifest === undefined) {
    throw new Error("Could not locate the installed pi-ai package");
  }
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-004: load the selected runtime artifact with its authoritative source contract.
  const ai: typeof NativeAI = await import(
    pathToFileURL(join(dirname(manifest), "dist/index.js")).href
  );
  return ai;
}
