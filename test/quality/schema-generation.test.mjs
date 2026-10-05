import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifact = "src/runs/background/schemas/RunContracts.json";

function generate(cwd, ...args) {
  const result = spawnSync(process.execPath, ["scripts/generate-run-schemas.mjs", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /(?:Generated|Verified) 23 canonical run schemas/);
}

await test("canonical schemas are checkout-independent without hiding schema or compiler changes", () => {
  const temporary = mkdtempSync(join(tmpdir(), "pi-schema-generation-"));
  try {
    const expected = readFileSync(join(root, artifact), "utf8");
    succeeds(generate(root, "--check"));
    for (const name of ["checkout-one", "another-checkout-root"]) {
      const checkout = join(temporary, name);
      mkdirSync(join(checkout, "scripts"), { recursive: true });
      for (const file of ["src", "node_modules", "package.json"]) {
        cpSync(join(root, file), join(checkout, file), {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
        });
      }
      cpSync(
        join(root, "scripts/generate-run-schemas.mjs"),
        join(checkout, "scripts/generate-run-schemas.mjs"),
      );
      succeeds(generate(checkout));
      assert.equal(readFileSync(join(checkout, artifact), "utf8"), expected);
      succeeds(generate(checkout, "--check"));

      const identifier =
        `import("${checkout}/src/shared/types/workflow",` +
        '{with:{"resolution-mode":"import"}}).ChainOutputMapEntry';
      const reference = `#/definitions/${encodeURIComponent(identifier)}`;
      const data = { $ref: reference, definitions: { literal: { $ref: reference } } };
      appendFileSync(
        join(checkout, "src/shared/types/async.ts"),
        `\nexport interface AsyncResultFile {\n` +
          `/** @default ${JSON.stringify(data)} */\n` +
          `readonly schemaPathProbe?: ${JSON.stringify(identifier)};\n}\n`,
      );
      const stale = generate(checkout, "--check");
      assert.equal(stale.status, 1, stale.stdout + stale.stderr);
      assert.match(stale.stderr, /Stale run schema/);
      succeeds(generate(checkout));
      const changed = JSON.parse(readFileSync(join(checkout, artifact), "utf8"));
      const probe = changed.definitions.AsyncResultFile.properties.schemaPathProbe;
      assert.equal(probe.const, identifier);
      assert.deepEqual(probe.default, data);
      succeeds(generate(checkout, "--check"));

      appendFileSync(
        join(checkout, "src/shared/types/async.ts"),
        "\nexport const generatorCompilerProbe: string = 42;\n",
      );
      const invalid = generate(checkout, "--check");
      assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
      assert.match(invalid.stderr, /Canonical run types could not be compiled/);
      assert.match(invalid.stderr, /Type 'number' is not assignable to type 'string'/);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
