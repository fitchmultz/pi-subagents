import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NativeTypebox from "typebox";
import type * as NativeValue from "typebox/value";
import { packageRoot } from "./host.ts";

const require = createRequire(path.join(packageRoot(), "dist/index.js"));
// The detached runner needs the selected host's dependencies, not Jiti aliases.
// oxlint-disable-next-line typescript/no-unsafe-assignment
const typebox: typeof NativeTypebox = await import(pathToFileURL(require.resolve("typebox")).href);
// oxlint-disable-next-line typescript/no-unsafe-assignment
const value: typeof NativeValue = await import(
  pathToFileURL(require.resolve("typebox/value")).href
);
export const { Type } = typebox;
export const Assert: typeof NativeValue.Assert = value.Assert;
