import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { record, json } from "../support/assertions.ts";
const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const buildScript = join(projectRoot, "scripts", "build.mjs");

const tscStub = fileURLToPath(new URL("../fixtures/build-tsc-stub.cjs", import.meta.url));
const faultPreload = fileURLToPath(
  new URL("../fixtures/build-fs-fault-preload.mjs", import.meta.url),
);

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "build-swap-"));
  mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
  copyFileSync(tscStub, join(dir, "node_modules", "typescript", "bin", "tsc"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
  return dir;
}

function faultArgs(): string[] {
  return ["--import", pathToFileURL(faultPreload).href];
}

async function runBuild(
  cwd: string,
  env: Readonly<Record<string, string>> = {},
  nodeArgs: readonly string[] = [],
): Promise<{ code: number; stderr: string }> {
  return await new Promise((done) => {
    execFileCallback(
      process.execPath,
      [...nodeArgs, buildScript, join(cwd, "node_modules", "typescript", "bin", "tsc")],
      {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
      },
      (error, _stdout, stderr) => {
        let code = 0;
        if (error !== null) {
          code = typeof error.code === "number" ? error.code : 1;
        }
        done({ code, stderr });
      },
    );
  });
}

function stagingDirs(cwd: string): string[] {
  return readdirSync(cwd).filter((name) => name.startsWith("dist.staging."));
}

async function withFixture(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = makeFixture();
  try {
    await run(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

nodeTest(
  "build.mjs: loaded provenance fingerprints emitted code and stays fixed until a fresh import",
  () =>
    withFixture(async (dir) => {
      assert.equal((await runBuild(dir)).code, 0);
      const stamp = pathToFileURL(join(dir, "dist", "build-info.js")).href;
      assert.ok(
        existsSync(fileURLToPath(stamp)),
        "a built runtime must carry its own provenance, not reread package.json after loading",
      );
      const initialModule: unknown = await import(stamp);
      const loaded = record(record(initialModule).EXTENSION_BUILD);
      const expectedHash = createHash("sha256")
        .update("index.js\0")
        .update(readFileSync(join(dir, "dist", "index.js")))
        .update("\0")
        .digest("hex");
      assert.deepEqual(loaded, { version: "1.2.3", sha256: expectedHash });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ type: "module", version: "2.0.0" }),
      );
      assert.equal((await runBuild(dir, { TSC_STUB_MARKER: "changed compiled code" })).code, 0);
      const reimported: unknown = await import(stamp);
      assert.equal(
        record(reimported).EXTENSION_BUILD,
        loaded,
        "a loaded module must not impersonate the rebuilt files on disk",
      );
      const fresh = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `console.log(JSON.stringify((await import(${JSON.stringify(stamp)})).EXTENSION_BUILD))`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(fresh.status, 0, fresh.stderr);
      const next = json(fresh.stdout);
      assert.equal(next.version, "2.0.0");
      assert.notEqual(next.sha256, loaded.sha256);
    }),
);

nodeTest("build.mjs: Android uses a native tsgo on PATH without an npm platform compiler", () =>
  withFixture(async (dir) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "tsgo"),
      `#!${process.execPath}\nprocess.env.TSC_STUB_MARKER = "native Android compiler";\nawait import(${JSON.stringify(pathToFileURL(tscStub).href)});\n`,
      { mode: 0o700 },
    );
    const platform = join(dir, "android.mjs");
    writeFileSync(platform, 'Object.defineProperty(process, "platform", { value: "android" });\n');
    rmSync(join(dir, "node_modules"), { recursive: true });
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(platform).href, buildScript],
      {
        cwd: dir,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(dir, "dist/index.js"), "utf8"),
      'export const built = "native Android compiler";\n',
    );
  }),
);

nodeTest("build.mjs: failed compile preserves the previous dist and cleans staging", () =>
  withFixture(async (dir) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");
    const { code } = await runBuild(dir, { TSC_STUB_FAIL: "1" });
    assert.notEqual(code, 0);
    assert.ok(existsSync(join(dir, "dist", "sentinel.txt")));
    assert.deepEqual(stagingDirs(dir), []);
  }),
);

nodeTest("build.mjs: successful build replaces dist, purging stale files", () =>
  withFixture(async (dir) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "stale.txt"), "old output");
    assert.equal((await runBuild(dir)).code, 0);
    assert.ok(existsSync(join(dir, "dist", "index.js")));
    assert.ok(!existsSync(join(dir, "dist", "stale.txt")));
    assert.deepEqual(stagingDirs(dir), []);
  }),
);

nodeTest("build.mjs: reaps dead-pid staging and keeps live-pid staging", () =>
  withFixture(async (dir) => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    assert.equal(typeof deadPid, "number");
    mkdirSync(join(dir, `dist.staging.${deadPid}`, "partial"), { recursive: true });
    mkdirSync(join(dir, `dist.staging.${deadPid}.previous`, "retired"), { recursive: true });
    mkdirSync(join(dir, `dist.staging.${process.pid}`, "inflight"), { recursive: true });
    assert.equal((await runBuild(dir)).code, 0);
    assert.ok(!existsSync(join(dir, `dist.staging.${deadPid}`)));
    assert.ok(!existsSync(join(dir, `dist.staging.${deadPid}.previous`)));
    assert.ok(existsSync(join(dir, `dist.staging.${process.pid}`)));
  }),
);

nodeTest("build.mjs: warns and continues when stranded staging cannot be removed", () =>
  withFixture(async (dir) => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    assert.equal(typeof deadPid, "number");
    const lockedName = `dist.staging.${deadPid}`;
    mkdirSync(join(dir, lockedName, "partial"), { recursive: true });
    const result = await runBuild(
      dir,
      { BUILD_SWAP_FAULT: "stale-rm", LOCKED_STAGING_NAME: lockedName },
      faultArgs(),
    );
    assert.equal(result.code, 0);
    assert.match(result.stderr, /could not remove staging/);
    assert.ok(existsSync(join(dir, lockedName)));
    assert.ok(existsSync(join(dir, "dist", "index.js")));
  }),
);

nodeTest("build.mjs: fails loudly when the previous dist cannot be retired", () =>
  withFixture(async (dir) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");
    const result = await runBuild(
      dir,
      { BUILD_SWAP_FAULT: "stale-rm", LOCKED_STAGING_NAME: "dist" },
      faultArgs(),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /synthetic stale-staging lock/);
    assert.ok(existsSync(join(dir, "dist", "sentinel.txt")));
    assert.deepEqual(stagingDirs(dir), []);
  }),
);

nodeTest("build.mjs: concurrent build storms succeed with valid dist", { timeout: 30_000 }, () =>
  withFixture(async (dir) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "stale.txt"), "old output");
    const results = await Promise.all(Array.from({ length: 4 }, () => runBuild(dir)));
    assert.deepEqual(
      results.flatMap((result) => (result.code === 0 ? [] : [result.stderr])),
      [],
    );
    assert.deepEqual(readdirSync(join(dir, "dist")).sort(), ["build-info.js", "index.js"]);
    assert.deepEqual(stagingDirs(dir), []);
  }),
);

nodeTest(
  "build.mjs: publishes retained staging instead of timing out on a slow winner",
  { timeout: 10_000 },
  () =>
    withFixture(async (dir) => {
      const result = await runBuild(dir, { BUILD_SWAP_FAULT: "late-winner" }, faultArgs());
      assert.deepEqual(result, { code: 0, stderr: "" });
      assert.ok(existsSync(join(dir, "dist", "index.js")));
      assert.ok(existsSync(join(dir, "dist", "late-winner.txt")));
      assert.deepEqual(stagingDirs(dir), []);
    }),
);

nodeTest("build.mjs: deterministically discards staging after a concurrent winner", () =>
  withFixture(async (dir) => {
    const result = await runBuild(dir, { BUILD_SWAP_FAULT: "race-loss" }, faultArgs());
    assert.equal(result.code, 0);
    assert.match(result.stderr, /dist\/ was published by a concurrent build/);
    assert.ok(existsSync(join(dir, "dist", "winner.txt")));
    assert.deepEqual(stagingDirs(dir), []);
  }),
);

nodeTest("build.mjs: does not accept an empty dist as a published winner", () =>
  withFixture(async (dir) => {
    const result = await runBuild(dir, { BUILD_SWAP_FAULT: "empty-dist" }, faultArgs());
    assert.deepEqual(result, { code: 0, stderr: "" });
    assert.ok(existsSync(join(dir, "dist", "index.js")));
    assert.deepEqual(stagingDirs(dir), []);
  }),
);

nodeTest(
  "build.mjs: restores the exact previous dist after persistent publication failure",
  { timeout: 10_000 },
  () =>
    withFixture(async (dir) => {
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "sentinel.txt"), "previous build");
      const result = await runBuild(dir, { BUILD_SWAP_FAULT: "rename-always" }, faultArgs());
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /synthetic permanent rename failure/);
      assert.deepEqual(readdirSync(join(dir, "dist")), ["sentinel.txt"]);
      assert.equal(readFileSync(join(dir, "dist", "sentinel.txt"), "utf8"), "previous build");
      assert.deepEqual(stagingDirs(dir), []);
    }),
);

nodeTest(
  "build.mjs: rethrows when the staged emit disappears before publication",
  { timeout: 10_000 },
  () =>
    withFixture(async (dir) => {
      const result = await runBuild(dir, { BUILD_SWAP_FAULT: "vanish-staging" }, faultArgs());
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /ENOENT/);
      assert.ok(!existsSync(join(dir, "dist")));
      assert.deepEqual(stagingDirs(dir), []);
    }),
);
