import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../../src/shared/unknown.ts";

/**
 * A host record as written by the release automation.
 * @typedef {{ flavor: string, directory: string, packageDir: string, packageDirs: Record<string, string>, version: string, provenance: Record<string, unknown>, index: string, cli: string, indexSha256: string, cliSha256: string, cohort: Record<string, string>, companions: Record<string, string>, runtimeLockSha256: string, runtimeGraphSha256: string }} HostRecord
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
/** @type {{ isolatedEnvironment: (root: string) => NodeJS.ProcessEnv, run: (command: string, args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv, quiet?: boolean, timeout?: number, stdio?: "inherit" | "pipe" }) => string | null, stageSource: (source: string, destination: string) => void }} */
// oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-004: load the selected runtime artifact with its authoritative source contract.
const { isolatedEnvironment, run, stageSource } = await import(
  pathToFileURL(join(automation, "scripts/common.mjs")).href
);
/** @type {{ prepareHost: (host: string, flavor: string, target: string, env: NodeJS.ProcessEnv) => Promise<HostRecord>, selectDevelopmentHost: (development: string, host: HostRecord, env: NodeJS.ProcessEnv) => { packageDir: string, index: string, cli: string } }} */
// oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-004: load the selected runtime artifact with its authoritative source contract.
const { prepareHost, selectDevelopmentHost } = await import(
  pathToFileURL(join(automation, "scripts/hosts.mjs")).href
);

/**
 * @param {HostRecord} host
 * @param {Record<string, unknown>} expected
 */
function assertOfficialProvenance(host, expected) {
  assert.ok(isRecord(expected.provenance));
  for (const key of ["version", "integrity", "tarball", "installer"]) {
    assert.deepEqual(
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
  const [major = 0, minor = 0, patch = 0] = host.version.replace(/-.*$/, "").split(".").map(Number);
  assert.ok(
    major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 2))),
    "Resolved latest host is below the supported 1.5.2 floor",
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
  const editorOutput = run("git", ["rev-parse", "HEAD"], {
    cwd: testEnv.PI_EDITOR_RECEIPT_TEST_ROOT,
    env,
    quiet: true,
  });
  assert.ok(editorOutput !== null);
  const editorRef = editorOutput.trim();
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
    /** @type {unknown} */
    const release = JSON.parse(readFileSync(join(candidate, "release.json"), "utf8"));
    assert.ok(isRecord(release));
    const { filename, hosts } = release;
    assert.ok(typeof filename === "string" && isRecord(hosts));
    assert.equal(basename(filename), filename, "Candidate filename must be local to the artifact");
    const expected = hosts[flavor];
    assert.ok(isRecord(expected), `Candidate did not record a ${flavor} host`);
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
        candidateHost.provenance,
        expected.provenance,
        "Fork host artifact differs from the candidate",
      );
      candidateSelected = selectDevelopmentHost(development, candidateHost, env);
    } else {
      assertOfficialProvenance(candidateHost, expected);
    }
    /** @type {(keyof HostRecord)[]} */
    const identityFields = [
      "version",
      "indexSha256",
      "cliSha256",
      "cohort",
      "companions",
      "runtimeLockSha256",
    ];
    for (const key of identityFields) {
      assert.deepEqual(candidateHost[key], expected[key], `Host ${key} differs from the candidate`);
    }
    // npm installs platform-specific optional dependencies; the recorded graph was prepared on Linux.
    if (process.platform === "linux") {
      assert.equal(
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
