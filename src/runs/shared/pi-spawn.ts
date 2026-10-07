import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

function isPiPackage(file: string): boolean {
  if (!fs.existsSync(file)) {
    return false;
  }
  const pkg: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  return (
    typeof pkg === "object" && pkg !== null && "name" in pkg && pkg.name === PI_CODING_AGENT_PACKAGE
  );
}

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
  let dir = path.dirname(entryPoint);
  while (dir !== path.dirname(dir)) {
    if (isPiPackage(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return;
}

function findPathPiPackage(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    try {
      const root = findPiPackageRootFromEntry(fs.realpathSync(path.join(dir, "pi")));
      if (root !== undefined) {
        return root;
      }
    } catch {
      // PATH entries can disappear or be wrappers rather than Pi.
    }
  }
  return;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
  try {
    return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
  } catch {
    return findPathPiPackage();
  }
}

export function resolvePiPackageRoot(): string | undefined {
  try {
    const entry = process.argv.at(1);
    return entry !== undefined ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
  } catch {
    // process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
    return;
  }
}

export function requirePiPackageRoot(): string {
  const configured = process.env.PI_PACKAGE_DIR;
  const root =
    configured !== undefined && configured.length > 0
      ? configured
      : (resolvePiPackageRoot() ?? resolveInstalledPiPackageRoot());
  if (root === undefined) {
    throw new Error(
      "Could not locate Pi runtime APIs; Pi must be installed and available on PATH.",
    );
  }
  return root;
}

export function getPiSpawnCommand(args: readonly string[]): { command: string; args: string[] } {
  return { command: "pi", args: [...args] };
}
