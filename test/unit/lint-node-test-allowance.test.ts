import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";

const repoRoot = join(import.meta.dirname, "..", "..");

// The qualified six-control probe for the node:test registration allowance
// (quality exception QX-001). Each control is a separate probe file so a
// single type-aware oxlint run observes every boundary.
const probes: Record<string, string> = {
  "allowed-registrations.ts": `import { describe as nodeDescribe, it as nodeIt, test as nodeTest } from "node:test";
import assert from "node:assert/strict";

nodeTest("top level registration", () => {
  assert.ok(process.pid > 0);
});

nodeIt("aliased registration", () => {
  assert.ok(process.pid > 0);
});

nodeDescribe("suite body registration", () => {
  nodeIt("inner registration", () => {
    assert.ok(process.pid > 0);
  });
});
`,
  "context-subtest.ts": `import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";

nodeTest("outer", (t) => {
  t.test("unawaited context subtest", () => {
    assert.ok(process.pid > 0);
  });
});
`,
  "local-name.ts": `import assert from "node:assert/strict";

function nodeTest(name: string, fn: () => Promise<void>): Promise<void> {
  assert.ok(name.length > 0);
  return fn();
}

nodeTest("unawaited local same-named call", () => Promise.resolve());
`,
  "name-source.ts": `export function nodeTest(name: string, fn: () => Promise<void>): Promise<void> {
  if (name.length === 0) {
    throw new Error("empty name");
  }
  return fn();
}
`,
  "imported-name.ts": `import { nodeTest } from "./name-source.ts";

nodeTest("unawaited imported same-named call", () => Promise.resolve());
`,
  "inside-body.ts": `import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";

function work(): Promise<void> {
  return Promise.resolve();
}

nodeTest("body", () => {
  work();
  assert.ok(process.pid > 0);
});
`,
  "unrelated-call.ts": `import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";

function unrelated(): Promise<void> {
  return Promise.resolve();
}

unrelated();

nodeTest("registration", () => {
  assert.ok(process.pid > 0);
});
`,
};

// Every control diagnostic is asserted at its exact probe line, so the probe
// sources embed their line positions by construction.
const expectedControls: Record<string, number> = {
  "context-subtest.ts": 5,
  "local-name.ts": 8,
  "imported-name.ts": 3,
  "inside-body.ts": 9,
  "unrelated-call.ts": 8,
};

nodeTest("node:test registration allowance passes all six qualification controls", (t) => {
  const tsgolintDir = join(
    repoRoot,
    "node_modules",
    "@oxlint-tsgolint",
    `${process.platform}-${process.arch}`,
  );
  if (!existsSync(tsgolintDir)) {
    t.skip(
      `no published oxlint type-aware backend for ${process.platform}-${process.arch}; hosted CI owns this policy evidence`,
    );
    return;
  }

  const probeRoot = mkdtempSync(
    join(process.env.PI_SUBAGENT_TEMP_ROOT ?? tmpdir(), "lint-policy-"),
  );
  t.after(() => rmSync(probeRoot, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(probes)) {
    writeFileSync(join(probeRoot, name), source);
  }
  writeFileSync(
    join(probeRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          allowJs: true,
          checkJs: true,
          noEmit: true,
          types: ["node"],
          module: "nodenext",
          moduleResolution: "nodenext",
          lib: ["ES2025"],
        },
        include: ["./**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const probeTypes = join(probeRoot, "node_modules", "@types");
  mkdirSync(probeTypes, { recursive: true });
  symlinkSync(join(repoRoot, "node_modules", "@types", "node"), join(probeTypes, "node"));

  const run = spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules", "oxlint", "bin", "oxlint"),
      "--type-aware",
      "--config",
      join(repoRoot, ".oxlintrc.json"),
      ...Object.keys(probes).map((name) => join(probeRoot, name)),
    ],
    {
      cwd: probeRoot,
      encoding: "utf8",
      env: { ...process.env, OXLINT_TSGOLINT_PATH: tsgolintDir },
    },
  );

  const findings = new Map<string, { line: number; plugin: string; rule: string }[]>();
  for (const outputLine of run.stdout.split("\n")) {
    const match = /^(\S+):(\d+):\d+: error ([\w-]+)\(([\w/-]+)\)/.exec(outputLine);
    if (match) {
      const file = match[1].replaceAll("\\", "/").split("/").pop() ?? "";
      const entry = findings.get(file) ?? [];
      entry.push({ line: Number(match[2]), plugin: match[3], rule: match[4] });
      findings.set(file, entry);
    }
  }

  // Control 1: intended unawaited top-level and suite-body registrations pass
  // for each distinct form the repository uses, and the shared helper stays
  // clean.
  assert.equal(findings.has("allowed-registrations.ts"), false);
  assert.equal(findings.has("name-source.ts"), false);

  // Controls 2-6: every boundary case still produces exactly the intended
  // no-floating-promises diagnostic at its exact site.
  for (const [file, line] of Object.entries(expectedControls)) {
    assert.deepEqual(
      findings.get(file),
      [{ line, plugin: "typescript", rule: "no-floating-promises" }],
      `${file} must keep exactly the no-floating-promises control diagnostic`,
    );
  }
  assert.notEqual(run.status, 0, "the probe set must fail lint overall");
});
