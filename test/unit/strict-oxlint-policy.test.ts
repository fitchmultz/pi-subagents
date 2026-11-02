import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test as nodeTest } from "node:test";

const repoRoot = join(import.meta.dirname, "..", "..");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readJson = (file: string): unknown => JSON.parse(readFileSync(join(repoRoot, file), "utf8"));

const scanDirectives = (dir: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      found.push(...scanDirectives(full));
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      for (const line of readFileSync(join(repoRoot, full), "utf8").split("\n")) {
        const match = /\/\/ oxlint-disable(?:-next-line)? +(.+?)(?: *--|$)/.exec(line);
        const names = match?.at(1);
        if (names !== undefined) {
          found.push(...names.split(",").map((rule) => rule.trim()));
        }
      }
    }
  }
  return found;
};

nodeTest("the adopted standard copy records the integrated version", () => {
  const standard = readFileSync(join(repoRoot, "docs/strict-oxlint-oxfmt-standard.md"), "utf8");
  assert.match(standard, /\*\*Version 5\.1\.2 · 1 November 2026\*\*/);
});

nodeTest("the effective lint policy matches the adopted baseline", () => {
  const config = readJson(".oxlintrc.json");
  assert.ok(isRecord(config));
  assert.ok(Array.isArray(config.plugins));
  assert.deepEqual(config.plugins, [
    "eslint",
    "typescript",
    "unicorn",
    "oxc",
    "import",
    "promise",
    "node",
  ]);
  assert.ok(Array.isArray(config.ignorePatterns));
  assert.deepEqual(config.ignorePatterns, ["dist/**", "dist.staging*/**"]);
  assert.ok(isRecord(config.categories));
  assert.deepEqual(config.categories, {
    correctness: "error",
    suspicious: "error",
    perf: "error",
    pedantic: "off",
    style: "off",
    restriction: "off",
    nursery: "off",
  });
  assert.ok(isRecord(config.options));
  assert.deepEqual(config.options, {
    typeAware: true,
    typeCheck: false,
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
    respectEslintDisableDirectives: false,
  });

  // QX-001: the node:test registration allowance stays package-origin with
  // distinct local names (docs/quality-exceptions.md).
  assert.ok(isRecord(config.rules));
  const floating = config.rules["typescript/no-floating-promises"];
  assert.ok(Array.isArray(floating));
  const settings: unknown = floating.at(1);
  assert.ok(isRecord(settings));
  assert.ok(Array.isArray(settings.allowForKnownSafeCalls));
  assert.deepEqual(settings.allowForKnownSafeCalls, [
    { from: "package", package: "node:test", name: ["nodeTest", "nodeIt", "nodeDescribe"] },
  ]);
  assert.ok(Array.isArray(settings.allowForKnownSafePromises));
  assert.deepEqual(settings.allowForKnownSafePromises, []);
});

nodeTest("the overrides inventory is exactly the four recorded profile mappings", () => {
  const config = readJson(".oxlintrc.json");
  assert.ok(isRecord(config));
  assert.ok(Array.isArray(config.overrides));
  assert.equal(config.overrides.length, 4);
  const observer: unknown = config.overrides.at(0);
  const tests: unknown = config.overrides.at(1);
  const declarations: unknown = config.overrides.at(2);
  const typeTests: unknown = config.overrides.at(3);
  assert.ok(isRecord(observer) && isRecord(observer.rules));
  assert.ok(isRecord(tests) && isRecord(tests.rules));
  assert.ok(isRecord(declarations) && isRecord(declarations.rules));
  assert.ok(isRecord(typeTests) && isRecord(typeTests.rules));

  assert.ok(Array.isArray(observer.files));
  assert.deepEqual(observer.files, [
    "src/agent/observe-card.ts",
    "src/agent/observe-chrome.ts",
    "src/agent/observe-layout.ts",
    "src/agent/observe-reading.ts",
    "src/agent/observe-screen.ts",
    "src/agent/observe-transcript.ts",
  ]);

  const relaxedSize = {
    complexity: [{ max: 15, variant: "modified" }],
    "max-depth": [{ max: 4 }],
    "max-params": [{ max: 6 }],
  };
  const sizeOff = {
    "max-statements": "off",
    "max-lines-per-function": "off",
    "max-lines": "off",
  };

  assert.deepEqual(tests.files, [
    "**/*.test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    "**/*.spec.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    "**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    "test/support/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    "test/fixtures/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
  ]);
  assert.deepEqual(tests.rules["import/no-unassigned-import"], [
    "error",
    { allow: ["../support/isolated-home.ts", "./isolated-home.ts"] },
  ]);
  assert.deepEqual(tests.rules["typescript/no-unnecessary-condition"], [
    "error",
    { checkTypePredicates: false, allowConstantLoopConditions: "only-allowed-literals" },
  ]);
  for (const [rule, setting] of Object.entries(relaxedSize)) {
    assert.deepEqual(tests.rules[rule], ["error", setting.at(0)]);
    assert.deepEqual(typeTests.rules[rule], ["error", setting.at(0)]);
  }
  for (const [rule, setting] of Object.entries(sizeOff)) {
    assert.equal(tests.rules[rule], setting);
    assert.equal(declarations.rules[rule], setting);
    assert.equal(typeTests.rules[rule], setting);
  }

  assert.deepEqual(declarations.files, ["**/*.d.{ts,mts,cts}"]);
  assert.deepEqual(declarations.rules.complexity, "off");
  assert.deepEqual(declarations.rules["max-depth"], "off");
  assert.deepEqual(declarations.rules["max-params"], "off");

  assert.deepEqual(typeTests.files, ["**/*.test-d.{ts,mts,cts}"]);
  assert.deepEqual(typeTests.rules["typescript/ban-ts-comment"], [
    "error",
    {
      "ts-check": false,
      "ts-expect-error": "allow-with-description",
      "ts-ignore": true,
      "ts-nocheck": true,
      minimumDescriptionLength: 10,
    },
  ]);
});

nodeTest("the compiler profile keeps every adopted strict flag", () => {
  const config = readJson("tsconfig.json");
  assert.ok(isRecord(config));
  const options = config.compilerOptions;
  assert.ok(isRecord(options));
  for (const flag of [
    "strict",
    "noImplicitReturns",
    "allowJs",
    "checkJs",
    "noUnusedLocals",
    "noFallthroughCasesInSwitch",
    "noImplicitOverride",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noUncheckedSideEffectImports",
    "forceConsistentCasingInFileNames",
    "noEmit",
  ]) {
    assert.equal(options[flag], true, flag);
  }
});

nodeTest("every disabled rule name belongs to the recorded directive inventory", () => {
  const disabled = new Set<string>();
  for (const dir of ["src", "scripts", "test", ".github"]) {
    for (const rule of scanDirectives(dir)) {
      if (rule !== "") {
        disabled.add(rule);
      }
    }
  }
  assert.deepEqual([...disabled].sort(), [
    "eslint/no-empty-function",
    "max-params",
    "no-await-in-loop",
    "no-control-regex",
    "no-param-reassign",
    "typescript/no-floating-promises",
    "typescript/no-misused-promises",
    "typescript/no-unnecessary-boolean-literal-compare",
    "typescript/no-unnecessary-condition",
    "typescript/no-unnecessary-type-assertion",
    "typescript/no-unsafe-argument",
    "typescript/no-unsafe-assignment",
    "typescript/no-unsafe-member-access",
    "typescript/no-unsafe-return",
    "typescript/no-unsafe-type-assertion",
    "typescript/prefer-readonly",
    "typescript/strict-boolean-expressions",
    "typescript/strict-void-return",
    "typescript/unbound-method",
  ]);
});
