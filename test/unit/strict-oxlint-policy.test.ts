import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import {
  checkCompiler,
  checkConfiguration,
  expectedLint,
  readJson,
} from "../../quality/configuration.ts";
import { checkDirectives } from "../../quality/directives.ts";
import { isRecord } from "../../src/shared/unknown.ts";

const root = join(import.meta.dirname, "../..");

nodeTest(
  "the repository implements the full normative policy, not a finding-count baseline",
  () => {
    assert.deepEqual(readJson(root, ".oxlintrc.json"), expectedLint(root));
  },
);

nodeTest(
  "semantic analysis, categories, explicit rules and override scope cannot be silently relaxed",
  (t) => {
    const expected = expectedLint(root);
    const directory = mkdtempSync(join(tmpdir(), "ps-policy-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "docs"));
    for (const file of [".oxfmtrc.json", "docs/strict-oxlint-oxfmt-standard.md"]) {
      writeFileSync(join(directory, file), readFileSync(join(root, file)));
    }
    const files = [
      ".oxfmtrc.json",
      ".oxlintrc.json",
      "tsconfig.build.json",
      "tsconfig.client.json",
      "tsconfig.json",
    ];
    writeFileSync(join(directory, ".oxlintrc.json"), JSON.stringify(expected));
    checkConfiguration(directory, files);
    assert.throws(
      () => checkConfiguration(directory, [...files, "tools/oxlint.config.ts"]),
      /nested configuration/,
    );
    for (const field of [
      "rules",
      "categories",
      "plugins",
      "options",
      "overrides",
      "ignorePatterns",
    ]) {
      const downgraded = { ...expected, [field]: {} };
      writeFileSync(join(directory, ".oxlintrc.json"), JSON.stringify(downgraded));
      assert.throws(() => checkConfiguration(directory, files), /Lint policy/);
    }
  },
);

nodeTest("the compiler checker rejects individual strict-family downgrades", () => {
  const config = readJson(root, "tsconfig.json");
  const { compilerOptions } = config;
  assert.ok(isRecord(compilerOptions));
  checkCompiler(config);
  for (const flag of [
    "strict",
    "checkJs",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "strictNullChecks",
  ]) {
    assert.throws(
      () =>
        checkCompiler({
          compilerOptions: { ...compilerOptions, [flag]: false },
        }),
      /Compiler/,
    );
  }
});

nodeTest(
  "only the authorized operation may consume an exception, including unchanged-count substitutions",
  () => {
    const file = "src/agent/host.ts";
    const source = readFileSync(join(root, file), "utf8");
    checkDirectives(file, source);
    assert.throws(() => checkDirectives("src/copied.ts", source), /unauthorized directive/);
    const directive = source.split("\n").find((line) => line.includes("oxlint-disable-next-line"));
    assert.ok(directive !== undefined);
    const unrelated = `\n${directive}\nexport const unrelated: HostSDK = await import("unrelated:" + process.pid);\n`;
    assert.throws(
      () => checkDirectives(file, source.replace(directive, "") + unrelated),
      /unauthorized directive/,
    );
    assert.throws(() => checkDirectives(file, source + unrelated), /unauthorized directive/);
    assert.throws(() => checkDirectives(file, source.replace(directive, "")), /stale exception/);
    const multiple = source.replace(
      'const sdk: HostSDK = await import(pathToFileURL(path.join(root, "dist/index.js")).href);',
      'const sdk: HostSDK = await import(pathToFileURL(path.join(root, "dist/index.js")).href), extra: HostSDK = await import(root);',
    );
    assert.throws(() => checkDirectives(file, multiple), /exactly one operation/);
    const duplicate = source.replace(
      "  return sdk;",
      `  {\n${directive}\n    const sdk: HostSDK = await import(pathToFileURL(path.join(root, "dist/index.js")).href);\n    console.log(sdk);\n  }\n  return sdk;`,
    );
    assert.throws(() => checkDirectives(file, duplicate), /duplicated exception/);
  },
);

nodeTest(
  "directive-looking strings are data, while real broad and compiler suppressions fail",
  () => {
    checkDirectives("src/example.ts", 'export const example = "// oxlint-disable no-debugger";');
    for (const directive of [
      "// oxlint-disable no-debugger",
      "/* eslint-disable no-debugger */",
      "// @ts-ignore",
      "// @ts-nocheck",
      "// prettier-ignore",
      "// oxlint-disable-next-line no-debugger -- QX-999: unauthorized",
    ]) {
      assert.throws(() => checkDirectives("src/example.ts", directive + "\ndebugger;"));
    }
  },
);

nodeTest("negative type tests require explained compiler-checked expectations", () => {
  const source =
    '// @ts-expect-error deliberate incompatible primitive assignment\nconst bad: number = "wrong";';
  checkDirectives("test/fixtures/consumer.test-d.ts", source);
  assert.throws(() => checkDirectives("src/consumer.ts", source), /negative type tests/);
  assert.throws(
    () =>
      checkDirectives(
        "test/fixtures/consumer.test-d.ts",
        source.replace("deliberate incompatible primitive assignment", "short"),
      ),
    /explain/,
  );
});

nodeTest("the captured SQLite method retains its real receiver and cannot escape", () => {
  const file = "test/fixtures/intercom-wake-window.ts";
  const source = readFileSync(join(root, file), "utf8");
  checkDirectives(file, source);
  assert.throws(
    () =>
      checkDirectives(
        file,
        source.replace(
          "nativeExec.call(this, sql)",
          "nativeExec.call(DatabaseSync.prototype, sql)",
        ),
      ),
    /actual database receiver/,
  );
  assert.throws(
    () =>
      checkDirectives(
        file,
        source.replace(
          "nativeExec.call(this, sql);",
          "nativeExec.call(this, sql);\n    nativeExec(sql);",
        ),
      ),
    /cannot escape/,
  );
});

nodeTest("the side-effect import decision belongs to the real isolation bootstrap", () => {
  checkDirectives("test/unit/example.test.ts", 'import "../support/isolated-home.ts";');
  checkDirectives("test/support/example.ts", 'import "./isolated-home.ts";');
  assert.throws(
    () => checkDirectives("test/unit/example.test.ts", 'import "./isolated-home.ts";'),
    /actual isolation owner/,
  );
});
