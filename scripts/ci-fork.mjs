import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [suite, automationArg, sourceArg, packageArg, expectedRef] = process.argv.slice(2);
assert.ok(["core", "smoke"].includes(suite) && automationArg && sourceArg && packageArg && /^[a-f0-9]{40}$/.test(expectedRef ?? ""),
  "Usage: node scripts/ci-fork.mjs core|smoke AUTOMATION SOURCE FORK_PACKAGE FORK_SHA");

const automation = resolve(automationArg);
const source = resolve(sourceArg);
const { isolatedEnvironment, run, stageSource } = await import(pathToFileURL(join(automation, "scripts/common.mjs")).href);
const { prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(automation, "scripts/hosts.mjs")).href);
const root = mkdtempSync("/tmp/ps-ci-");
const env = isolatedEnvironment(root);

try {
  const development = join(root, "development");
  stageSource(source, development);
  run("npm", ["ci", "--ignore-scripts"], { cwd: development, env });
  const host = await prepareHost(join(root, "host"), "fork", resolve(packageArg), env);
  assert.equal(host.provenance.ref, expectedRef);
  const selected = selectDevelopmentHost(development, host, env);
  const testEnv = {
    ...env,
    PI_COMPAT_HOST: "fork",
    PI_COMPAT_EXPECTED_VERSION: host.version,
    PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir,
    PI_HOST_INDEX: selected.index,
    PI_HOST_CLI: selected.cli,
    PI_PACKAGE_DIR: selected.packageDir,
  };
  run("npm", ["run", "build"], { cwd: development, env: testEnv });

  if (suite === "core") {
    const result = spawnSync(process.execPath, ["scripts/compat-native.mjs", "--core"], {
      cwd: development, env: testEnv, stdio: "inherit", timeout: 480_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Core contracts exited ${result.status ?? result.signal}`);
  } else {
    const consumer = join(root, "consumer");
    stageSource(source, consumer);
    run("npm", ["install", "--omit=dev"], { cwd: consumer, env });
    assert.ok(existsSync(join(consumer, "dist/extension/index.js")));
    assert.equal(existsSync(join(consumer, "node_modules/typescript")), false, "Production install retained TypeScript");
    run(process.execPath, ["scripts/native-package-smoke.mjs", consumer], { cwd: development, env: testEnv });
    if (process.platform === "darwin") {
      run(process.execPath, ["--test", "test/unit/pi-intercom-spawn.test.ts"], { cwd: development, env: testEnv });
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
