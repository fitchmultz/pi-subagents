import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A host record as written by the release automation.
 * @typedef {{ version: string, provenance: Record<string, unknown>, indexSha256: string, cliSha256: string, cohort: string, companions: unknown, runtimeLockSha256: string, runtimeGraphSha256: string }} HostRecord
 */
const [flavor, target, automationArg, sourceArg] = process.argv.slice(2);
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node .github/scripts/ci-host.mjs official|fork VERSION|FORK_PACKAGE AUTOMATION SOURCE\n\nQualifies the once-resolved host with the full package contract and production Git/native install.\nEnvironment: PI_EDITOR_RECEIPT_TEST_ROOT selects the frozen editor checkout. PI_RELEASE_CANDIDATE optionally selects the verified candidate artifact directory; fork qualification also requires PI_RELEASE_FORK to select its prepared host artifact.\nExample: PI_EDITOR_RECEIPT_TEST_ROOT=editor node .github/scripts/ci-host.mjs official 1.0.2 automation extension\nExit codes: 0 passed; 1 invalid input or failed check.",
  );
  process.exit(0);
}
assert.ok(
  flavor !== undefined &&
    ["official", "fork"].includes(flavor) &&
    target !== undefined &&
    automationArg !== undefined &&
    sourceArg !== undefined,
);
assert.ok(
  process.env.PI_EDITOR_RECEIPT_TEST_ROOT !== undefined,
  "CI must supply the frozen native editor receipt source",
);
const automation = resolve(automationArg);
/** @type {{ isolatedEnvironment: (root: string) => NodeJS.ProcessEnv, run: (command: string, args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv, quiet?: boolean, timeout?: number, stdio?: "inherit" | "pipe" }) => string, stageSource: (source: string, destination: string) => void }} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const { isolatedEnvironment, run, stageSource } = await import(
  pathToFileURL(join(automation, "scripts/common.mjs")).href
);
/** @type {{ prepareHost: (host: string, flavor: string, target: string, env: NodeJS.ProcessEnv) => Promise<HostRecord>, selectDevelopmentHost: (development: string, host: HostRecord, env: NodeJS.ProcessEnv) => { packageDir: string, index: string, cli: string } }} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const { prepareHost, selectDevelopmentHost } = await import(
  pathToFileURL(join(automation, "scripts/hosts.mjs")).href
);

/**
 * @param {HostRecord} host
 * @param {HostRecord} expected
 */
function assertOfficialProvenance(host, expected) {
  for (const key of ["version", "integrity", "tarball", "installer"]) {
    assert.deepEqual(
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
      host.provenance[key],
      expected.provenance[key],
      `Official host ${key} differs from the candidate`,
    );
  }
}

const root = mkdtempSync("/tmp/ps-ci-");
const env = isolatedEnvironment(root);
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
    timeout: 1_650_000,
    stdio: "inherit",
  });
  if (process.env.PI_RELEASE_CANDIDATE !== undefined) {
    const candidate = resolve(process.env.PI_RELEASE_CANDIDATE);
    /** @type {{ filename: string, hosts: Record<string, HostRecord> }} */
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    const { filename, hosts } = JSON.parse(readFileSync(join(candidate, "release.json"), "utf8"));
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
    assert.equal(basename(filename), filename, "Candidate filename must be local to the artifact");
    const expected = hosts[flavor];
    assert.ok(expected !== undefined, `Candidate did not record a ${flavor} host`);
    let candidateHost = host;
    let candidateSelected = selected;
    if (flavor === "fork") {
      assert.ok(
        process.env.PI_RELEASE_FORK !== undefined,
        "Candidate qualification requires its prepared fork host",
      );
      candidateHost = await prepareHost(
        join(root, "release-host"),
        "fork",
        resolve(process.env.PI_RELEASE_FORK),
        env,
      );
      assert.deepEqual(
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
        candidateHost.provenance,
        expected.provenance,
        "Fork host artifact differs from the candidate",
      );
      candidateSelected = selectDevelopmentHost(development, candidateHost, env);
    } else {
      assertOfficialProvenance(candidateHost, expected);
    }
    for (const key of [
      "version",
      "indexSha256",
      "cliSha256",
      "cohort",
      "companions",
      "runtimeLockSha256",
    ]) {
      assert.deepEqual(
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
        /** @type {Record<string, unknown>} */ (candidateHost)[key],
        /** @type {Record<string, unknown>} */ (expected)[key],
        `Host ${key} differs from the candidate`,
      );
    }
    // npm installs platform-specific optional dependencies; the recorded graph was prepared on Linux.
    if (process.platform === "linux") {
      assert.equal(
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
        candidateHost.runtimeGraphSha256,
        expected.runtimeGraphSha256,
        "Linux host graph differs from the candidate",
      );
    }
    console.log(
      JSON.stringify({
        candidateQualification: flavor,
        platform: process.platform,
        runtimeGraphSha256: candidateHost.runtimeGraphSha256,
      }),
    );
    run("npm", ["run", "smoke:package", "--", join(candidate, filename)], {
      cwd: development,
      env: {
        ...testEnv,
        PI_COMPAT_EXPECTED_VERSION: candidateHost.version,
        PI_COMPAT_EXPECTED_PACKAGE_DIR: candidateSelected.packageDir,
        PI_HOST_INDEX: candidateSelected.index,
        PI_HOST_CLI: candidateSelected.cli,
        PI_PACKAGE_DIR: candidateSelected.packageDir,
      },
      stdio: "inherit",
    });
    if (flavor === "fork") {
      selectDevelopmentHost(development, host, env);
    }
  }
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
} finally {
  rmSync(root, { recursive: true, force: true });
}
