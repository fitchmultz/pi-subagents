import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type * as NativeTypebox from "typebox";
import type * as NativeValue from "typebox/value";
import { isChild, packageRoot } from "./host.ts";

// Pi aliases these imports to its own instance (including bundled virtual modules).
// Only the detached runner needs absolute imports from the selected host package.
const require = isChild() ? createRequire(path.join(packageRoot(), "dist/index.js")) : undefined;
// oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-004: detached runners resolve the selected host schema instance.
const typeboxPromise: Promise<typeof NativeTypebox> =
  require === undefined
    ? import("typebox")
    : import(pathToFileURL(require.resolve("typebox")).href);
// oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-004: validation must use the selected host schema instance.
const valuePromise: Promise<typeof NativeValue> =
  require === undefined
    ? import("typebox/value")
    : import(pathToFileURL(require.resolve("typebox/value")).href);
const [typebox, value] = await Promise.all([typeboxPromise, valuePromise]);
export const { Type } = typebox;
export const Assert: typeof NativeValue.Assert = value.Assert;
