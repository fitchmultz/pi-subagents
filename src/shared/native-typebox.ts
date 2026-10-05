import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";
import { importSelectedNative } from "./native-import.ts";

// Detached Node runners do not get Pi's extension-loader package aliases.
const require = createRequire(path.join(requirePiPackageRoot(), "dist/index.js"));
const typebox = await importSelectedNative(
  import.meta.url,
  "typebox",
  pathToFileURL(require.resolve("typebox")).href,
  () => import("typebox"),
);
const compile = await importSelectedNative(
  import.meta.url,
  "typebox/compile",
  pathToFileURL(require.resolve("typebox/compile")).href,
  () => import("typebox/compile"),
);
const value = await importSelectedNative(
  import.meta.url,
  "typebox/value",
  pathToFileURL(require.resolve("typebox/value")).href,
  () => import("typebox/value"),
);

export const { Type } = typebox;
export const { Compile } = compile;
export const { Check, Errors } = value;
