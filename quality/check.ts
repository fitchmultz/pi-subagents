import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/shared/unknown.ts";
import { checkConfiguration, checkCompiler, readJson } from "./configuration.ts";
import { checkDirectives } from "./directives.ts";
import {
  inventory,
  sourcePattern,
  compilerConfig,
  checkMembership,
  checkDependencies,
} from "./inventory.ts";

export function checkQuality(root: string): void {
  const files = inventory(root);
  checkConfiguration(root, files);
  const config = compilerConfig(root);
  checkCompiler(config);
  checkMembership(root, files, config);
  checkDependencies(root, files);
  const pkg = readJson(root, "package.json");
  assert.ok(isRecord(pkg.scripts));
  const commands = {
    build: "node ./scripts/build.mjs",
    "test:unit": "node scripts/run-tests.mjs unit",
    "test:integration": "node scripts/run-tests.mjs integration",
    typecheck: "node scripts/typescript.mjs --noEmit",
    "typecheck:declarations": "node quality/declarations.ts",
    "smoke:package": "node scripts/package-smoke.mjs",
    "smoke:install": "node scripts/local-install-smoke.mjs",
    "check:size": "node scripts/measure-size.mjs",
    "check:quality": "node quality/check.ts",
    lint: "oxlint --type-aware --deny-warnings .",
    "format:check": "oxfmt --check .",
    ci: "node quality/acceptance.ts",
  };
  for (const [name, command] of Object.entries(commands)) {
    assert.equal(
      pkg.scripts[name],
      command,
      `Required acceptance command ${name} or its scope changed`,
    );
  }
  for (const file of files.filter((name) => sourcePattern.test(name))) {
    checkDirectives(file, readFileSync(join(root, file), "utf8"));
  }
  console.log(
    `Quality policy: ${files.filter((file) => sourcePattern.test(file)).length} maintained source files covered.`,
  );
}

if (import.meta.main) {
  checkQuality(process.cwd());
}
