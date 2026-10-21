import * as fs from "node:fs";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as SDK from "@earendil-works/pi-coding-agent";

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
export async function loadSDK(root: string): Promise<typeof SDK> {
  // Selected host SDK, not a second package-local runtime hidden behind Jiti aliases.
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const sdk: typeof SDK = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
  return sdk;
}
export function runtimeEntry(): string {
  return fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../index.ts" : "../index.js", import.meta.url),
  );
}
export function isChild(): boolean {
  const root = process.env.PI_INTERCOM_ROOT_SESSION_ID;
  const parent = process.env.PI_INTERCOM_PARENT_SESSION_ID;
  if (root === undefined && parent === undefined) {
    return false;
  }
  if (
    root === undefined ||
    parent === undefined ||
    root.length === 0 ||
    parent.length === 0 ||
    root !== parent
  ) {
    throw new Error("Malformed child identity; delegation is disabled.");
  }
  return true;
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}
