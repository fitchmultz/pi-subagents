import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NativeSession from "@earendil-works/pi-coding-agent";

export async function loadNativeSession(packageRoot: string): Promise<typeof NativeSession> {
  // The trusted selected Pi package supplies this exact SDK declaration contract.
  // A computed URL is required: Jiti rewrites literal SDK imports to its own host graph.
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const sessionModule: typeof NativeSession = await import(
    pathToFileURL(path.join(packageRoot, "dist/index.js")).href
  );
  return sessionModule;
}
