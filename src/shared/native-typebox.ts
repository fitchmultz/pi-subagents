import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";

// Detached Node runners do not get Pi's extension-loader package aliases.
const require = createRequire(path.join(requirePiPackageRoot(), "dist/index.js"));
const typebox: typeof import("typebox") = await import(
  pathToFileURL(require.resolve("typebox")).href
);
const compile: typeof import("typebox/compile") = await import(
  pathToFileURL(require.resolve("typebox/compile")).href
);
const value: typeof import("typebox/value") = await import(
  pathToFileURL(require.resolve("typebox/value")).href
);

export const { Type } = typebox;
export const { Compile } = compile;
export const { Check, Errors } = value;
