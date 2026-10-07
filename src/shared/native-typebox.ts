import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NativeTypebox from "typebox";
import type * as NativeCompile from "typebox/compile";
import type * as NativeValue from "typebox/value";
import { requirePiPackageRoot } from "../runs/shared/pi-spawn.ts";

// Detached Node runners do not get Pi's extension-loader package aliases.
const require = createRequire(path.join(requirePiPackageRoot(), "dist/index.js"));
const typeboxURL = pathToFileURL(require.resolve("typebox")).href;
const compileURL = pathToFileURL(require.resolve("typebox/compile")).href;
const valueURL = pathToFileURL(require.resolve("typebox/value")).href;
// This trusted selected-host dependency supplies the actual TypeBox declarations.
// Jiti aliases literal imports to its own graph, so the resolved URL must remain authoritative.
// oxlint-disable-next-line typescript/no-unsafe-assignment
const typebox: typeof NativeTypebox = await import(typeboxURL);
// The selected host's TypeBox compiler implements this exact native compile contract.
// A computed URL prevents Jiti from substituting another host's compiler graph.
// oxlint-disable-next-line typescript/no-unsafe-assignment
const compile: typeof NativeCompile = await import(compileURL);
// The selected host's value module implements these native Check/Errors signatures.
// A computed URL preserves its real dependency graph under Jiti and detached Node.
// oxlint-disable-next-line typescript/no-unsafe-assignment
const value: typeof NativeValue = await import(valueURL);

export const { Type } = typebox;
export const { Compile } = compile;
export const { Check, Errors } = value;
