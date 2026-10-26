import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as SDK from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readIntercomLineage } from "../pi-intercom/identity.ts";

export { errorMessage as errorText } from "../shared/unknown.ts";

/** Fork-only exact native working state; official Pi lacks it, so its children stay resident. */
interface LocalWorkingState {
  readonly header: { readonly id: string };
  readonly sessionFile?: string;
  readonly leafId: string | null;
  readonly entries: readonly SDK.SessionEntry[];
}
type NativeWorkingState = typeof SDK extends { readWorkingSession: (file: string) => infer S }
  ? S
  : never;
export type WorkingState = [NativeWorkingState] extends [never]
  ? LocalWorkingState
  : NativeWorkingState;
// Working sessions stay optional even when the selected graph declares them, so both hosts
// keep one checked path. The native resolver is optional until official Pi exports it.
type HostSDK = Omit<
  typeof SDK,
  "readWorkingSession" | "writeWorkingSession" | "openWorkingSession"
> & {
  readWorkingSession?: (file: string) => WorkingState;
  writeWorkingSession?: (file: string, state: WorkingState) => void;
  openWorkingSession?: (state: WorkingState) => SDK.SessionManager;
  resolveModelReference?: (
    request: { text: string; provider: string; thinkingSuffix: "strict"; fuzzy: false },
    models: readonly Model<Api>[],
    usable: (provider: string) => boolean,
  ) =>
    | { status: "resolved"; model: Model<Api>; thinkingLevel?: ThinkingLevel }
    | { status: "ambiguous" | "not-found" };
};

function isPackage(root: string): boolean {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) {
    return false;
  }
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "@earendil-works/pi-coding-agent"
  );
}
function launcherPackage(): string | undefined {
  const entry = process.argv.at(1);
  if (entry === undefined) {
    return;
  }
  let directory = path.dirname(fs.realpathSync(entry));
  while (directory !== path.dirname(directory)) {
    if (isPackage(directory)) {
      return directory;
    }
    directory = path.dirname(directory);
  }
  return undefined;
}
export function packageRoot(): string {
  const configured = process.env.PI_PACKAGE_DIR;
  if (configured !== undefined && configured.length > 0) {
    if (!isPackage(configured)) {
      throw new Error("PI_PACKAGE_DIR is not a Pi SDK.");
    }
    return configured;
  }
  const launcher = launcherPackage();
  if (launcher !== undefined) {
    return launcher;
  }
  const manifest = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
  if (manifest === undefined) {
    throw new Error("Cannot locate the native Pi SDK.");
  }
  return path.dirname(manifest);
}
export async function loadSDK(root: string): Promise<HostSDK> {
  // Selected host SDK, not a second package-local runtime hidden behind Jiti aliases.
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const sdk: HostSDK = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
  return sdk;
}
export function runtimeEntry(): string {
  return fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../index.ts" : "../index.js", import.meta.url),
  );
}
export function isChild(): boolean {
  return readIntercomLineage() !== undefined;
}
