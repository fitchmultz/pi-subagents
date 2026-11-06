import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";

nodeTest("acceptance propagates failure and still runs every independent gate", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ps-acceptance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gates = [
    "lint",
    "format:check",
    "typecheck",
    "typecheck:declarations",
    "check:quality",
    "check:size",
    "smoke:package",
    "smoke:install",
    "test:unit",
    "test:integration",
  ];
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      scripts: Object.fromEntries(gates.map((gate) => [gate, `node gate.cjs ${gate}`])),
    }),
  );
  writeFileSync(
    join(directory, "gate.cjs"),
    `
const fs = require("node:fs");
const gate = process.argv[2];
fs.appendFileSync("visited.txt", gate + "\\n");
process.exitCode = gate === process.env.FAIL_GATE ? 1 : 0;
`,
  );
  for (const failed of ["", "lint"]) {
    writeFileSync(join(directory, "visited.txt"), "");
    const run = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../../quality/acceptance.ts")],
      {
        cwd: directory,
        env: { ...process.env, FAIL_GATE: failed },
        encoding: "utf8",
      },
    );
    assert.equal(run.error, undefined);
    assert.equal(run.status, failed === "" ? 0 : 1, run.stdout + run.stderr);
    assert.deepEqual(
      readFileSync(join(directory, "visited.txt"), "utf8").trim().split("\n"),
      gates,
    );
    if (failed !== "") {
      assert.ok(run.stdout.includes(`[acceptance] ${failed}: FAIL (1)`), run.stdout);
      assert.ok(run.stderr.includes(`Failed gates: ${failed}`), run.stderr);
    }
  }
});
