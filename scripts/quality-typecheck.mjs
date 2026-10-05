#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { checkScope, root, typeProjects } from "./quality-scope.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/quality-typecheck.mjs\nCompile effective maintained leaf projects in addition to canonical root typecheck.\nUses installed TypeScript 7 and preserves every compiler failure status.\nExit 0 when every leaf passes; Example: npm run typecheck:leaves",
  );
} else if (process.argv.length > 2) {
  throw new Error("Unknown compiler-scope option; use --help");
} else {
  checkScope();
  for (const { path } of typeProjects().filter(
    (entry) => entry.path !== resolve(root, "tsconfig.json"),
  )) {
    console.log(`Compiler leaf: ${path}`);
    const result = spawnSync(
      resolve(root, "node_modules/.bin/tsc"),
      ["--noEmit", "--project", path],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}
