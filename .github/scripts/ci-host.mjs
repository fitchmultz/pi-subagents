import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMPAT_TIMEOUT_MS,
  OwnedProcesses,
  currentEnclosure,
  run,
} from "../../scripts/compat-process.mjs";

async function encloseHost() {
  if (currentEnclosure()) {
    return;
  }
  // Enclose all pinned synchronous helpers, including stageSource, prepareHost
  // and selectDevelopmentHost. Their Apple descendants can conceal env receipts.
  // The existing job limit is 120m; each nested command keeps its own deadline.
  await run(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: process.env,
    stdio: "inherit",
    timeout: 120 * 60_000,
  });
  process.exit(0);
}

async function cleanup(root, env, qualificationFailed) {
  try {
    // Go extracts read-only module directories; only Go owns their removal.
    if (existsSync(env.GOMODCACHE)) {
      await run("go", ["clean", "-modcache"], { cwd: root, env });
    }
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (!qualificationFailed) {
      throw error;
    }
    console.error(`CI cleanup failed for ${root}:`, error);
  }
}

async function quiesce(processes, root, qualificationFailed) {
  try {
    await processes.stop();
    return true;
  } catch (error) {
    if (!qualificationFailed) {
      throw error;
    }
    console.error(`Owned CI processes remain; retaining ${root}:`, error);
    return false;
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
await encloseHost();
const automation = resolve(automationArg);
const { isolatedEnvironment, stageSource } = await import(
  pathToFileURL(join(automation, "scripts/common.mjs")).href
);
const { prepareHost, selectDevelopmentHost } = await import(
  pathToFileURL(join(automation, "scripts/hosts.mjs")).href
);
const root = mkdtempSync("/tmp/ps-ci-");
// Native private-session admission covers synchronous pinned helpers even when
// their Apple children hide environment receipts. Stop precedes root deletion.
const processes = new OwnedProcesses(isolatedEnvironment(root));
processes.inherit();
const env = { ...processes.environment, GOMODCACHE: join(root, "go-modules") };
let qualificationFailed = false;
try {
  const development = join(root, "development");
  stageSource(resolve(sourceArg), development);
  await run("npm", ["ci", "--ignore-scripts"], { cwd: development, env });
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
  const editorRef = (
    await run("git", ["rev-parse", "HEAD"], {
      cwd: testEnv.PI_EDITOR_RECEIPT_TEST_ROOT,
      env,
      quiet: true,
    })
  ).trim();
  console.log(
    JSON.stringify({
      qualification: flavor,
      version: host.version,
      provenance: host.provenance,
      editorRef,
    }),
  );
  await run("npm", ["run", "check:compat"], {
    cwd: development,
    env: testEnv,
    timeout: COMPAT_TIMEOUT_MS,
    stdio: "inherit",
  });
  const consumer = join(root, "git-consumer");
  stageSource(resolve(sourceArg), consumer);
  await run("npm", ["install", "--omit=dev"], { cwd: consumer, env });
  assert.equal(
    existsSync(join(consumer, "node_modules/typescript")),
    false,
    "Production install retained TypeScript",
  );
  await run(process.execPath, [join(development, "scripts/local-install-smoke.mjs")], {
    cwd: consumer,
    env: testEnv,
  });
  await run(process.execPath, ["scripts/native-package-smoke.mjs", consumer], {
    cwd: development,
    env: testEnv,
  });
} catch (error) {
  qualificationFailed = true;
  throw error;
} finally {
  if (await quiesce(processes, root, qualificationFailed)) {
    await cleanup(root, env, qualificationFailed);
  }
}
