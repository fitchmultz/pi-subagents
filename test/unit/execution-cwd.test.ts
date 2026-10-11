import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExecutionCwd } from "../../src/shared/execution-cwd.ts";
import { createEventBus, makeMinimalCtx } from "../support/helpers.ts";

test("an incompatible owner cannot silently launch at the native directory", () => {
  const pi = {
    events: createEventBus(),
    getAllTools: () => [],
    getCommands: () => [
      {
        name: "cwd",
        source: "extension" as const,
        sourceInfo: {
          source: "extension",
          path: "/fixtures/pi-change-working-dir/index.ts",
          scope: "user" as const,
          origin: "top-level" as const,
        },
      },
    ],
  };
  assert.throws(() => resolveExecutionCwd(pi, makeMinimalCtx("/native")), /did not resolve/);
});
