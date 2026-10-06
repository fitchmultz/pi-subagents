import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function cleanup(root, env, qualificationFailed) {
  try {
    // Go extracts read-only module directories; only Go owns their removal.
    if (existsSync(env.GOMODCACHE)) {
      run("go", ["clean", "-modcache"], { cwd: root, env });
    }
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (!qualificationFailed) {
      throw error;
    }
    console.error(`CI cleanup failed for ${root}:`, error);
  }
}

const [flavor, target, automationArg, sourceArg] = process.argv.slice(2);
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node .github/scripts/ci-host.mjs official|fork VERSION|FORK_PACKAGE AUTOMATION SOURCE\n\nQualifies the once-resolved host with the full package contract and production Git/native install.\nEnvironment: PI_EDITOR_RECEIPT_TEST_ROOT must select the frozen editor checkout.\nExample: PI_EDITOR_RECEIPT_TEST_ROOT=editor node .github/scripts/ci-host.mjs official 1.0.2 automation extension\nExit codes: 0 passed; 1 invalid input or failed check.",
  );
  process.exit(0);
}
assert.ok(["official", "fork"].includes(flavor) && target && automationArg && sourceArg);
assert.ok(
  process.env.PI_EDITOR_RECEIPT_TEST_ROOT,
  "CI must supply the frozen native editor receipt source",
);
const automation = resolve(automationArg);
const { isolatedEnvironment, run, stageSource } = await import(
  pathToFileURL(join(automation, "scripts/common.mjs")).href
);
const { prepareHost, selectDevelopmentHost } = await import(
  pathToFileURL(join(automation, "scripts/hosts.mjs")).href
);
const root = mkdtempSync("/tmp/ps-ci-");
const env = { ...isolatedEnvironment(root), GOMODCACHE: join(root, "go-modules") };
let qualificationFailed = false;
try {
  const development = join(root, "development");
  stageSource(resolve(sourceArg), development);
  run("npm", ["ci", "--ignore-scripts"], { cwd: development, env });
  const host = await prepareHost(
    join(root, "host"),
    flavor,
    flavor === "fork" ? resolve(target) : target,
    env,
  );
  if (flavor === "fork") {
    assert.equal(host.provenance.ref, process.env.PI_FORK_REF);
  }
  assert.ok(
    Number(host.version.split(".")[0]) >= 1,
    "Resolved latest host is below the supported floor",
  );
  const selected = selectDevelopmentHost(development, host, env);
  const testEnv = {
    ...env,
    PI_COMPAT_HOST: flavor,
    PI_COMPAT_EXPECTED_VERSION: host.version,
    PI_COMPAT_EXPECTED_PACKAGE_DIR: selected.packageDir,
    PI_HOST_INDEX: selected.index,
    PI_HOST_CLI: selected.cli,
    PI_PACKAGE_DIR: selected.packageDir,
    PI_EDITOR_RECEIPT_TEST_ROOT: resolve(process.env.PI_EDITOR_RECEIPT_TEST_ROOT),
  };
  const editorRef = run("git", ["rev-parse", "HEAD"], {
    cwd: testEnv.PI_EDITOR_RECEIPT_TEST_ROOT,
    env,
    quiet: true,
  }).trim();
  console.log(
    JSON.stringify({
      qualification: flavor,
      version: host.version,
      provenance: host.provenance,
      editorRef,
    }),
  );
  run("npm", ["run", "check:compat"], {
    cwd: development,
    env: testEnv,
    timeout: 1_200_000,
    stdio: "inherit",
  });
  const consumer = join(root, "git-consumer");
  stageSource(resolve(sourceArg), consumer);
  run("npm", ["install", "--omit=dev"], { cwd: consumer, env });
  assert.equal(
    existsSync(join(consumer, "node_modules/typescript")),
    false,
    "Production install retained TypeScript",
  );
  run(process.execPath, [join(development, "scripts/local-install-smoke.mjs")], {
    cwd: consumer,
    env: testEnv,
  });
  run(process.execPath, ["scripts/native-package-smoke.mjs", consumer], {
    cwd: development,
    env: testEnv,
  });
} catch (error) {
  qualificationFailed = true;
  throw error;
} finally {
  cleanup(root, env, qualificationFailed);
}
