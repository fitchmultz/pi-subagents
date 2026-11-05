import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import {
  compilerConfig,
  checkMembership,
  checkDependencies,
  inventory,
} from "../../quality/inventory.ts";
import { readJson } from "../../quality/configuration.ts";

const repository = join(import.meta.dirname, "../..");

function project(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "ps-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  const copied = [
    ".gitignore",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    "tsconfig.json",
    "package.json",
    "scripts/typescript.mjs",
    "quality/declarations.ts",
    "quality/inventory.ts",
    "quality/process.ts",
    "quality/compiler.ts",
    "src/shared/unknown.ts",
  ];
  for (const file of copied) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(repository, file)));
  }
  const git = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  writeFileSync(join(root, "src/covered.ts"), "export const covered = 1;\n");
  writeFileSync(join(root, "src/hidden.ts"), "export const hidden = 2;\n");
  writeFileSync(
    join(root, "src/checked.mjs"),
    "/** @type {number} */\nexport const checked = 1;\n",
  );
  return root;
}

function npm(root: string, script: string): ReturnType<typeof spawnSync> {
  const env = { ...process.env };
  // This is an independent CLI invocation, not a worker in the enclosing Node test run.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return spawnSync("npm", ["run", script], { cwd: root, encoding: "utf8", env });
}

nodeTest("native compiler and lint membership reject omitted maintained files", (t) => {
  const root = project(t);
  const files = inventory(root);
  checkMembership(root, files, compilerConfig(root));
  const compiler = readJson(root, "tsconfig.json");
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      ...compiler,
      exclude: ["node_modules", "dist", "dist.staging*", "src/hidden.ts"],
    }),
  );
  assert.throws(
    () => checkMembership(root, files, compilerConfig(root)),
    /src\/hidden.ts: missing compiler coverage/,
  );
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify(compiler));

  const lint = readJson(root, ".oxlintrc.json");
  writeFileSync(
    join(root, ".oxlintrc.json"),
    JSON.stringify({
      ...lint,
      ignorePatterns: ["dist/**", "dist.staging*/**", "src/hidden.ts"],
    }),
  );
  assert.throws(
    () => checkMembership(root, files, compilerConfig(root)),
    /src\/hidden.ts: missing native lint coverage/,
  );
  writeFileSync(join(root, ".oxlintrc.json"), JSON.stringify(lint));

  writeFileSync(join(root, ".gitignore"), "node_modules\nsrc/hidden.ts\n");
  assert.ok(
    inventory(root).includes("src/hidden.ts"),
    "Git-ignored maintained source remains inventoried",
  );
  assert.throws(
    () => checkMembership(root, inventory(root), compilerConfig(root)),
    /coverage|formatting/,
  );
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools/hidden.mjs"), "export const hidden = 1;\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ntools/\n");
  assert.ok(
    inventory(root).includes("tools/hidden.mjs"),
    "New maintained roots cannot disappear through an ignore",
  );
  assert.throws(
    () => checkMembership(root, inventory(root), compilerConfig(root)),
    /coverage|formatting/,
  );
});

nodeTest(
  "native dependency resolution catches test support through imports, exports, aliases and dynamic imports",
  (t) => {
    const root = project(t);
    mkdirSync(join(root, "test/support"), { recursive: true });
    writeFileSync(join(root, "test/support/helper.ts"), "export const value = 1;\n");
    const file = join(root, "src/covered.ts");
    const config = readJson(root, "tsconfig.json");
    assert.ok(typeof config.compilerOptions === "object" && config.compilerOptions !== null);
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        ...config,
        compilerOptions: {
          ...config.compilerOptions,
          paths: { "@fixture": ["./test/support/helper.ts"] },
        },
      }),
    );
    checkDependencies(root, inventory(root));
    for (const source of [
      'import { value } from "../test/support/helper.ts"; export { value };',
      'export { value } from "../test/support/helper.ts";',
      'export const value = await import("../test/support/helper.ts");',
      'export { value } from "@fixture";',
    ]) {
      writeFileSync(file, source);
      assert.throws(
        () => checkDependencies(root, inventory(root)),
        /test\/support\/helper.ts: production depends/,
      );
    }
  },
);

nodeTest("actual compiler gates check TypeScript, JavaScript and handwritten declarations", (t) => {
  const root = project(t);
  mkdirSync(join(root, "types"));
  const declaration = join(root, "types/contract.d.ts");
  writeFileSync(declaration, "export declare const value: string;\n");
  let run = npm(root, "typecheck:declarations");
  assert.equal(run.status, 0, String(run.stdout) + String(run.stderr));

  writeFileSync(declaration, "export declare const value: MissingContract;\n");
  run = npm(root, "typecheck:declarations");
  assert.notEqual(run.status, 0);
  assert.match(String(run.stderr), /contract\.d\.ts\(1,\d+\): error TS2304/);
  writeFileSync(declaration, "export declare const value: string;\n");

  run = npm(root, "typecheck");
  assert.equal(run.status, 0, String(run.stdout) + String(run.stderr));
  writeFileSync(join(root, "src/covered.ts"), 'export const covered: number = "wrong";\n');
  run = npm(root, "typecheck");
  assert.notEqual(run.status, 0);
  assert.match(String(run.stdout), /src\/covered\.ts\(1,\d+\): error TS2322/);
  writeFileSync(join(root, "src/covered.ts"), "export const covered = 1;\n");
  writeFileSync(
    join(root, "src/checked.mjs"),
    '/** @type {number} */\nexport const checked = "wrong";\n',
  );
  run = npm(root, "typecheck");
  assert.notEqual(run.status, 0);
  assert.match(String(run.stdout), /src\/checked\.mjs\(2,\d+\): error TS2322/);
});

nodeTest(
  "the formatter gate rejects changed maintained bytes and formatting is idempotent",
  (t) => {
    const root = project(t);
    let run = npm(root, "format");
    assert.equal(run.status, 0, String(run.stdout) + String(run.stderr));
    const source = join(root, "src/hidden.ts");
    const formatted = readFileSync(source, "utf8");
    run = npm(root, "format:check");
    assert.equal(run.status, 0, String(run.stdout) + String(run.stderr));
    writeFileSync(source, "export const hidden=2");
    run = npm(root, "format:check");
    assert.notEqual(run.status, 0);
    assert.match(String(run.stdout) + String(run.stderr), /src\/hidden\.ts/);
    run = npm(root, "format");
    assert.equal(run.status, 0);
    assert.equal(readFileSync(source, "utf8"), formatted);
    run = npm(root, "format");
    assert.equal(run.status, 0);
    assert.equal(readFileSync(source, "utf8"), formatted);
  },
);

nodeTest("a real failed assertion reaches the repository test command", (t) => {
  const root = project(t);
  writeFileSync(
    join(root, "scripts/run-tests.mjs"),
    readFileSync(join(repository, "scripts/run-tests.mjs")),
  );
  mkdirSync(join(root, "test/unit"), { recursive: true });
  const file = join(root, "test/unit/fixture.test.ts");
  const source =
    'import assert from "node:assert/strict";\nimport { test as nodeTest } from "node:test";\nnodeTest("assertion control", () => { assert.equal(1, 1); });\n';
  writeFileSync(file, source);
  let run = npm(root, "test:unit");
  assert.equal(run.status, 0, String(run.stdout) + String(run.stderr));
  assert.match(String(run.stdout), /assertion control/);
  assert.doesNotMatch(String(run.stderr), /skipping running files/);
  writeFileSync(file, source.replace("assert.equal(1, 1)", "assert.equal(1, 2)"));
  run = npm(root, "test:unit");
  assert.notEqual(run.status, 0, String(run.stdout) + String(run.stderr));
  assert.match(String(run.stdout) + String(run.stderr), /ERR_ASSERTION/);
  assert.match(String(run.stdout) + String(run.stderr), /fixture\.test\.ts:3/);
});
