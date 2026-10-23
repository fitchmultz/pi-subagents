import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NativeTypebox from "typebox";
import type * as NativeValue from "typebox/value";
import { isChild, packageRoot } from "./host.ts";

// Pi aliases these imports to its own instance (including bundled virtual modules).
// Only the detached runner needs absolute imports from the selected host package.
const require = isChild() ? createRequire(path.join(packageRoot(), "dist/index.js")) : undefined;
// oxlint-disable-next-line typescript/no-unsafe-assignment
const typebox: typeof NativeTypebox =
  require === undefined
    ? await import("typebox")
    : await import(pathToFileURL(require.resolve("typebox")).href);
// oxlint-disable-next-line typescript/no-unsafe-assignment
const value: typeof NativeValue =
  require === undefined
    ? await import("typebox/value")
    : await import(pathToFileURL(require.resolve("typebox/value")).href);
export const { Type } = typebox;
export const Assert: typeof NativeValue.Assert = value.Assert;
