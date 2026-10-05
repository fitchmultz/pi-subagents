import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { root } from "../../scripts/quality-scope.mjs";

export const config = JSON.parse(readFileSync(resolve(root, ".oxlintrc.json"), "utf8"));
export const engine = resolve(root, "node_modules/.cache/pi-quality-engine/tsgolint");

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-quality-probe-"));
  mkdirSync(join(directory, "node_modules"));
  for (const name of readdirSync(resolve(root, "node_modules")).filter(
    (entry) => !entry.startsWith("."),
  )) {
    symlinkSync(resolve(root, "node_modules", name), join(directory, "node_modules", name));
  }
  put(directory, "package.json", JSON.stringify({ type: "module" }));
  put(
    directory,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noImplicitReturns: true,
        noEmit: true,
        target: "ES2025",
        lib: ["ES2025"],
        allowImportingTsExtensions: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        allowJs: true,
        checkJs: false,
        types: ["node"],
        skipLibCheck: true,
      },
      include: ["**/*.ts", "**/*.mjs", "**/*.js"],
      exclude: ["node_modules"],
    }),
  );
  return directory;
}

export function put(directory, file, content) {
  mkdirSync(dirname(join(directory, file)), { recursive: true });
  writeFileSync(join(directory, file), content);
}

export function remove(directory) {
  rmSync(directory, { recursive: true, force: true });
}

export function lint(directory, ruleNames, files = ["main.ts"], changes = {}) {
  const rules = Object.fromEntries(ruleNames.map((name) => [name, config.rules[name]]));
  put(
    directory,
    ".oxlintrc.json",
    JSON.stringify({
      plugins: config.plugins,
      categories: { correctness: "off", suspicious: "off", perf: "off" },
      env: config.env,
      overrides: changes.overrides ?? config.overrides,
      options: { typeAware: true, typeCheck: false, denyWarnings: true },
      rules: { ...rules, ...changes.rules },
    }),
  );
  const result = spawnSync(resolve(root, "node_modules/.bin/oxlint"), ["--format=json", ...files], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, OXLINT_TSGOLINT_PATH: engine },
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.stderr.trim(), "", result.stderr);
  assert.ok(result.status === 0 || result.status === 1, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.ok(Array.isArray(output.diagnostics), result.stdout);
  assert.equal(result.status, output.diagnostics.length > 0 ? 1 : 0, result.stdout);
  assert.ok(
    output.diagnostics.every(
      (entry) =>
        entry.severity === "error" &&
        typeof entry.code === "string" &&
        !entry.code.includes("parse"),
    ),
    result.stdout,
  );
  return output.diagnostics
    .map((entry) => ({
      rule: entry.code.replace(/^(.+)\((.+)\)$/, "$1/$2").replace(/^eslint\//, ""),
      file: entry.filename,
      line: entry.labels[0].span.line,
    }))
    .sort((left, right) => left.line - right.line);
}

export function compiler(directory, file = "tsconfig.json") {
  return spawnSync(resolve(root, "node_modules/.bin/tsc"), ["--noEmit", "--project", file], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
  });
}
