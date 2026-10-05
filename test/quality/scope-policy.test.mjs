import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  uncheckedJavaScript,
  uncheckedRules,
  root,
  installedRules,
  maintainedFiles,
} from "../../scripts/quality-scope.mjs";
import { suppressionProblems } from "../../scripts/quality-policy.mjs";
import { config, fixture, lint, put, remove, compiler, engine } from "./probe-support.mjs";

await test("effective checkJs, inherited settings, ts-check and test role stay distinct", () => {
  const dir = fixture();
  try {
    spawnSync("git", ["init", "--quiet"], { cwd: dir });
    put(dir, ".gitignore", "node_modules/\n");
    put(
      dir,
      "unchecked.js",
      "export function unsafe(value) { return value.missing(); }\ndebugger;\n",
    );
    put(
      dir,
      "opt-in.js",
      "// @ts-check\nexport function unsafe(value) { return value.missing(); }\n",
    );
    put(
      dir,
      "checked/base.json",
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          strict: true,
          noImplicitReturns: true,
          noEmit: true,
        },
        include: ["*.js"],
      }),
    );
    put(dir, "checked/tsconfig.json", '{"extends":"./base.json"}');
    put(
      dir,
      "checked/checked.test.js",
      "export function unsafe(value) { return value.missing(); }\n",
    );
    put(
      dir,
      "main.ts",
      'import { unsafe } from "./unchecked.js";\nexport const value: string = unsafe(1);\n',
    );
    assert.deepEqual(uncheckedJavaScript(dir), ["unchecked.js"]);
    const overrides = [{ files: ["unchecked.js"], rules: uncheckedRules() }];
    const rules = Object.fromEntries(
      ["no-debugger", "typescript/no-unsafe-call", "typescript/no-unsafe-assignment"].map(
        (rule) => [rule, config.rules[rule]],
      ),
    );
    put(
      dir,
      ".oxlintrc.json",
      JSON.stringify({
        plugins: config.plugins,
        categories: { correctness: "off" },
        options: { typeAware: true, typeCheck: false },
        rules,
        overrides,
      }),
    );
    const result = spawnSync(resolve(root, "node_modules/.bin/oxlint"), ["--format=json", "."], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, OXLINT_TSGOLINT_PATH: engine },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const findings = JSON.parse(result.stdout).diagnostics;
    assert.deepEqual(
      findings.filter((entry) => entry.filename === "unchecked.js").map((entry) => entry.code),
      ["eslint(no-debugger)"],
    );
    for (const name of ["opt-in.js", "checked/checked.test.js"]) {
      assert.ok(
        findings.some(
          (entry) => entry.filename === name && entry.code === "typescript(no-unsafe-call)",
        ),
        name,
      );
    }
    assert.ok(
      findings.some(
        (entry) =>
          entry.filename === "main.ts" && entry.code === "typescript(no-unsafe-assignment)",
      ),
    );
    const rootCompiler = compiler(dir);
    assert.equal(rootCompiler.status, 1, rootCompiler.stdout + rootCompiler.stderr);
    assert.match(rootCompiler.stdout, /opt-in.js.*TS7006/);
    assert.doesNotMatch(rootCompiler.stdout, /unchecked.js.*error TS/);
    const inheritedCompiler = compiler(dir, "checked/tsconfig.json");
    assert.equal(inheritedCompiler.status, 1, inheritedCompiler.stdout + inheritedCompiler.stderr);
    assert.match(inheritedCompiler.stdout, /checked.test.js.*TS7006/);
    const metadata = installedRules().filter((rule) => rule.type_aware);
    assert.ok(metadata.length > 0);
    assert.ok(metadata.every((rule) => uncheckedRules()[`${rule.scope}/${rule.value}`] === "off"));
  } finally {
    remove(dir);
  }
});

await test("comment-aware suppression policy rejects directives but not inert text", () => {
  const cases = [
    ['const text = "// oxlint-disable";', "src/main.ts", 0],
    ["const text = `// @ts-nocheck`;", "src/main.ts", 0],
    ["const regex = /oxlint-disable/;", "src/main.ts", 0],
    ["// oxlint-disable\nconst value = 1;", "src/main.ts", 1],
    ["// eslint-disable-next-line no-eval\nconst value = 1;", "src/main.ts", 1],
    ["// oxlint-disable-next-line typescript/no-floating-promises\nwork();", "src/main.ts", 1],
    ["// oxlint-disable-next-line no-await-in-loop\nawait work();", "src/main.ts", 1],
    [
      "// Each journal commit must finish before the following entry.\n// oxlint-disable-next-line no-await-in-loop\nawait work();",
      "src/main.ts",
      0,
    ],
    ["/* @ts-ignore */\nconst value = 1;", "src/main.ts", 1],
    ["// @ts-nocheck\nconst value = 1;", "src/main.ts", 1],
    ["// @ts-expect-error: verifies a rejected public contract\nwork();", "src/main.ts", 1],
    ["// @ts-expect-error: verifies a rejected public contract\nwork();", "test/api.test-d.ts", 0],
    ["// @ts-expect-error: short\nwork();", "test/api.test-d.ts", 1],
    ["const fn = () => { /* oxlint-disable */ return 1; };", "src/main.ts", 1],
    ["const text = `value ${1 /* @ts-ignore */}`;", "src/main.ts", 1],
  ];
  for (const [source, file, count] of cases) {
    assert.equal(suppressionProblems(source, file).length, count, source);
  }
});

await test("compiler errors remain an independent failure gate", () => {
  const dir = fixture();
  try {
    put(dir, "main.ts", "export const value: string = 1;");
    assert.deepEqual(lint(dir, ["no-debugger"]), []);
    const result = compiler(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /main.ts\(1,14\): error TS2322/);
  } finally {
    remove(dir);
  }
});

await test("actual CLI discovery covers the entire maintained code inventory", () => {
  const result = spawnSync(resolve(root, "node_modules/.bin/oxlint"), ["--debug=files", "."], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.stdout.trim().split("\n").sort(), maintainedFiles().sort());
});

await test("canonical compiler command cannot select the API alias through npm's shared shim", () => {
  const dir = fixture();
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    put(
      dir,
      "package.json",
      JSON.stringify({ type: "module", scripts: { typecheck: manifest.scripts.typecheck } }),
    );
    put(dir, "main.ts", "export const value: string = 1;");
    put(dir, "node_modules/.bin/tsc", "#!/bin/sh\necho 'Wrong compiler shim selected'\nexit 0\n");
    chmodSync(resolve(dir, "node_modules/.bin/tsc"), 0o755);
    const result = spawnSync("npm", ["run", "typecheck"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /main.ts\(1,14\): error TS2322/);
    assert.doesNotMatch(result.stdout, /Wrong compiler shim selected/);
  } finally {
    remove(dir);
  }
});

await test("approved checker directives stay confined to their actual boundary contracts", () => {
  const cases = [
    [
      "unicorn/no-thenable",
      "src/extension/schemas.ts",
      "const schema = {\n$then$\n};",
      [
        ['then: { type: "string" },', 0],
        ["then: Type.String(),", 0],
        ['"then": false,', 0],
        ["then: () => 1,", 1],
        ["then: ordinaryFunction,", 1],
      ],
    ],
    [
      "typescript/no-invalid-void-type",
      "src/slash/slash-bridge.ts",
      "$then$",
      [
        ["type Subscription = void | (() => void);", 0],
        ["type Subscription = (() => void) | void;", 0],
        ["type Subscription = string | (() => void);", 1],
        ["type Subscription = void | (() => number);", 1],
        ["type Subscription = void | ((event: string) => void);", 1],
        ["type Subscription = void | (() => void) | number;", 1],
      ],
    ],
    [
      "typescript/no-unsafe-assignment",
      "src/shared/native-typebox.ts",
      "$then$",
      [
        [
          'const typebox: typeof import("typebox") = await import(pathToFileURL(nativePath).href);',
          0,
        ],
        [
          'const compile: typeof import("typebox/compile") = await import(new URL(nativePath).href);',
          0,
        ],
        ['const value: typeof import("typebox/value") = await import(nativeUrl);', 0],
        ['const typebox: Pick<typeof import("typebox"), "Type"> = await import(nativeUrl);', 0],
        ["const typebox: typeof NativeTypebox = await import(nativeUrl);", 0],
        ['const typebox: typeof import("other-package") = await import(nativeUrl);', 1],
        ['const ordinary: typeof import("typebox") = await import(nativeUrl);', 1],
        ['let typebox: typeof import("typebox") = await import(nativeUrl);', 1],
        ["const typebox = await import(nativeUrl);", 1],
        ['const typebox: typeof import("typebox") = await import("typebox");', 1],
        ['const typebox: typeof import("typebox") = await import(arbitraryUrl);', 1],
        ['const typebox: typeof import("typebox") = load(nativeUrl);', 1],
        ['const typebox: typeof import("typebox") = arbitraryValue;', 1],
      ],
    ],
    [
      "typescript/prefer-readonly-parameter-types",
      "src/main.ts",
      "function invoke<T>(\n$then$\n): T { return operation(); }",
      [
        ["operation: () => T,", 0],
        ["operation: (() => T) & { state: string[] },", 1],
        ["operation: () => string[],", 1],
        ["operation: { execute: () => T },", 1],
      ],
    ],
  ];
  const prefix = [
    'import type * as NativeTypebox from "typebox";',
    "const nativeUrl = pathToFileURL(nativePath).href;",
    "const arbitraryUrl = ordinaryFunction();",
  ].join("\n");
  for (const [rule, file, template, variants] of cases) {
    for (const [statement, count] of variants) {
      const directive = [
        "// This site retains the reviewed native boundary and original API contract.",
        `// oxlint-disable-next-line ${rule}`,
        statement,
      ].join("\n");
      const source = `${prefix}\n${template.replace("$then$", directive)}`;
      assert.equal(suppressionProblems(source, file).length, count, `${rule}: ${statement}`);
      if (count === 0 && rule !== "typescript/prefer-readonly-parameter-types") {
        assert.equal(
          suppressionProblems(source, "src/ordinary.ts").length,
          1,
          `${rule}: ordinary source must not inherit a boundary exception`,
        );
      }
    }
  }
});
