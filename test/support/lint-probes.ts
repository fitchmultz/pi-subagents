import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";

const root = join(import.meta.dirname, "../..");
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly plugin: string;
  readonly rule: string;
  readonly message?: string;
}

export function lintProbes(
  t: TestContext,
  probes: Readonly<Record<string, string>>,
): Finding[] | undefined {
  const backend = join(
    root,
    "node_modules/@oxlint-tsgolint",
    `${process.platform}-${process.arch}`,
  );
  if (!existsSync(backend)) {
    t.skip(
      `No published semantic backend for ${process.platform}-${process.arch}; supported-host acceptance is required.`,
    );
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "ps-lint-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  writeFileSync(join(directory, "tsconfig.json"), readFileSync(join(root, "tsconfig.json")));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
  for (const [file, source] of Object.entries(probes)) {
    writeFileSync(join(directory, file), source);
  }
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/oxlint/bin/oxlint"),
      "--type-aware",
      "--deny-warnings",
      "--format=agent",
      "--config",
      join(root, ".oxlintrc.json"),
      ...Object.keys(probes).map((file) => join(directory, file)),
    ],
    { cwd: directory, encoding: "utf8", env: { ...process.env, OXLINT_TSGOLINT_PATH: backend } },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "", "Native controls must not fail on setup or backend errors");
  const findings: Finding[] = [];
  for (const line of result.stdout.split("\n").filter((text) => text !== "")) {
    const match = /^(.*):(\d+):\d+: error ([\w-]+)\(([\w/-]+)\)/.exec(line);
    if (match === null) {
      const unused = /^(.*):(\d+):\d+: error: (Unused oxlint-disable directive .+)$/.exec(line);
      assert.ok(unused !== null, "Unexpected diagnostic output: " + line);
      const [, file, at, message] = unused;
      assert.ok(file !== undefined && at !== undefined && message !== undefined);
      findings.push({ file: basename(file), line: Number(at), plugin: "", rule: "", message });
      continue;
    }
    const [, path, lineText, plugin, rule] = match;
    assert.ok(
      path !== undefined && lineText !== undefined && plugin !== undefined && rule !== undefined,
    );
    findings.push({ file: basename(path), line: Number(lineText), plugin, rule });
  }
  assert.equal(
    result.status,
    findings.length === 0 ? 0 : 1,
    "Native diagnostic exit status must propagate",
  );
  return findings;
}
