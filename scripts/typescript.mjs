#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Android's npm compiler package is not published; use its installed native compiler.
 * @param {string} [script]
 * @returns {{ command: string, args: string[] }}
 */
export function compilerInvocation(script) {
  if (script === undefined && process.platform === "android") {
    return { command: "tsgo", args: [] };
  }
  const compiler = script ?? join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(compiler)) {
    throw new Error(`typescript is not installed at ${compiler}; run npm install first.`);
  }
  return { command: process.execPath, args: [compiler] };
}

if (import.meta.main) {
  const compiler = compilerInvocation();
  const result = spawnSync(compiler.command, [...compiler.args, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      process.platform === "android"
        ? `Cannot run native TypeScript: install an Android build of tsgo on PATH. ${result.error.message}`
        : result.error.message,
    );
  }
  process.exitCode = result.status ?? 1;
}
