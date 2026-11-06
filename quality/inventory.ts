import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { run } from "./process.ts";
import { compilerFiles } from "./compiler.ts";
import { isRecord } from "../src/shared/unknown.ts";

export const sourcePattern = /\.(?:[cm]?[jt]sx?)$/;
export const declarationPattern = /\.d\.[cm]?ts$/;

function walk(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    const name = relative(root, file);
    // npm dependencies/cache, TypeScript publication trees and private Pi/Git state
    // have their own owners. Every other directory is inspected, regardless of Git ignores.
    if (
      [".git", ".pi", "node_modules", ".npm-cache", "dist"].includes(name) ||
      /^dist\.staging\.\d+(?:\.previous)?$/.test(name) ||
      entry.name === ".DS_Store"
    ) {
      return [];
    }
    return entry.isDirectory() ? walk(root, file) : [name];
  });
}

export function inventory(root: string): string[] {
  const tracked = run("git", ["ls-files", "--cached", "-z"], root)
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(root, file)));
  return [...new Set([...tracked, ...walk(root)])].filter((file) => file !== "").sort();
}

export function isTest(file: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|test)\//.test(file) || /\.(?:test|spec|test-d)\.[cm]?[jt]sx?$/.test(file)
  );
}

export function checkDependencies(root: string, files: readonly string[]): void {
  const production = files.filter((file) => sourcePattern.test(file) && !isTest(file));
  assert.ok(production.length > 0, "Production dependency selection cannot be empty");
  const closure = new Set(compilerFiles(root, production, "dependencies").trim().split("\n"));
  for (const file of files.filter(isTest)) {
    assert.ok(!closure.has(resolve(root, file)), `${file}: production depends on test-only source`);
  }
}

export function compilerConfig(root: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    run(process.execPath, ["scripts/typescript.mjs", "--showConfig"], root),
  );
  assert.ok(isRecord(value), "TypeScript must resolve a project");
  return value;
}

export function checkMembership(
  root: string,
  files: readonly string[],
  config: Record<string, unknown>,
): void {
  assert.ok(Array.isArray(config.files), "TypeScript must report file membership");
  const members = new Set(
    config.files.map((file: unknown) => {
      assert.ok(typeof file === "string");
      return resolve(root, file);
    }),
  );
  const linted = new Set(
    run(process.execPath, ["node_modules/oxlint/bin/oxlint", "--debug", "files", "."], root)
      .trim()
      .split("\n")
      .map((file) => resolve(root, file.trim())),
  );
  for (const file of files.filter((name) => sourcePattern.test(name))) {
    assert.ok(members.has(resolve(root, file)), `${file}: missing compiler coverage`);
    assert.ok(linted.has(resolve(root, file)), `${file}: missing native lint coverage`);
  }
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
    cwd: root,
    input: files.join("\0") + "\0",
    encoding: "utf8",
  });
  assert.ok(ignored.status === 0 || ignored.status === 1, ignored.stderr);
  // Captured command logs under docs/evidence retain the command's original bytes.
  const hidden = ignored.stdout
    .split("\0")
    .filter((file) => file !== "" && !/^docs\/evidence\/.*\.log$/.test(file));
  assert.deepEqual(hidden, [], "Maintained files must not be hidden from formatting by .gitignore");
}
