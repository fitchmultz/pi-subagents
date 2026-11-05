import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/shared/unknown.ts";

export function readJson(root: string, file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(join(root, file), "utf8"));
  assert.ok(isRecord(value), `${file} must contain an object`);
  return value;
}

function jsonBlock(document: string, section: string): Record<string, unknown> {
  const text = document.split(section).at(1)?.split("```json\n").at(1)?.split("\n```").at(0);
  assert.ok(text !== undefined, `Missing normative JSON in ${section}`);
  const value: unknown = JSON.parse(text);
  assert.ok(isRecord(value));
  return value;
}

export function expectedLint(root: string): Record<string, unknown> {
  const standard = readFileSync(join(root, "docs/strict-oxlint-oxfmt-standard.md"), "utf8");
  assert.match(standard, /\*\*Version 5\.2 · 3 November 2026\*\*/);
  const config = jsonBlock(standard, "## Appendix A: Base Oxlint configuration");
  assert.ok(
    Array.isArray(config.plugins) && Array.isArray(config.overrides) && isRecord(config.rules),
  );
  config.plugins.push("node");
  config.env = { node: true };
  config.ignorePatterns = ["dist/**", "dist.staging*/**"];
  const tests: unknown = config.overrides[0];
  assert.ok(isRecord(tests) && Array.isArray(tests.files) && isRecord(tests.rules));
  tests.files.push(
    "test/support/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    "test/fixtures/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
  );
  // QX-001: native registrations, not context subtests. Kept in the test profile only.
  const floating = config.rules["typescript/no-floating-promises"];
  assert.ok(Array.isArray(floating));
  const options: unknown = floating[1];
  assert.ok(isRecord(options));
  tests.rules["typescript/no-floating-promises"] = [
    "error",
    {
      ...options,
      allowForKnownSafeCalls: [
        { from: "package", package: "node:test", name: ["nodeTest", "nodeIt", "nodeDescribe"] },
      ],
    },
  ];
  // QX-005: isolation must run before imported production modules evaluate.
  tests.rules["import/no-unassigned-import"] = [
    "error",
    { allow: ["../support/isolated-home.ts", "./isolated-home.ts"] },
  ];
  config.overrides.unshift({
    files: [
      "src/agent/observe-card.ts",
      "src/agent/observe-chrome.ts",
      "src/agent/observe-layout.ts",
      "src/agent/observe-reading.ts",
      "src/agent/observe-screen.ts",
      "src/agent/observe-transcript.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@earendil-works/**"],
              allowTypeImports: true,
              message: "Resolve lazy viewer values through the selected host in observe-layout.ts.",
            },
          ],
        },
      ],
    },
  });
  return config;
}

export function checkCompiler(config: Record<string, unknown>): void {
  assert.ok(isRecord(config.compilerOptions));
  const options = config.compilerOptions;
  for (const flag of [
    "strict",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "noImplicitOverride",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noUncheckedSideEffectImports",
    "forceConsistentCasingInFileNames",
    "allowJs",
    "checkJs",
  ]) {
    assert.equal(options[flag], true, `Compiler requires ${flag}`);
  }
  assert.equal(options.noCheck, false);
  for (const flag of [
    "alwaysStrict",
    "noImplicitAny",
    "noImplicitThis",
    "strictNullChecks",
    "strictFunctionTypes",
    "strictBindCallApply",
    "strictPropertyInitialization",
    "strictBuiltinIteratorReturn",
    "useUnknownInCatchVariables",
  ]) {
    assert.notEqual(options[flag], false, `Compiler cannot disable ${flag}`);
  }
}

export function checkConfiguration(root: string, files: readonly string[]): void {
  assert.deepEqual(
    readJson(root, ".oxlintrc.json"),
    expectedLint(root),
    "Lint policy differs from v5.2 and its reviewed mappings",
  );
  const standard = readFileSync(join(root, "docs/strict-oxlint-oxfmt-standard.md"), "utf8");
  const formatter = jsonBlock(standard, "### 7.1 Formatter ownership");
  formatter.ignorePatterns = ["package-lock.json", "dist/**", "dist.staging*/**"];
  assert.deepEqual(
    readJson(root, ".oxfmtrc.json"),
    formatter,
    "Formatter ownership/options changed",
  );
  const compositions = files.filter(
    (file) =>
      /(?:^|\/)(?:\.oxlint|\.oxfmt|oxlint\.config|tsconfig).*\.(?:jsonc?|[cm]?[jt]s)$/.test(file) ||
      /(?:^|\/)\.(?:eslint|prettier)ignore$/.test(file),
  );
  assert.deepEqual(
    compositions,
    [
      ".oxfmtrc.json",
      ".oxlintrc.json",
      "tsconfig.build.json",
      "tsconfig.client.json",
      "tsconfig.json",
    ],
    "Review nested configuration and compiler coverage explicitly",
  );
}
