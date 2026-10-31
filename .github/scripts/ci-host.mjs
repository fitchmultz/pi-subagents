import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [flavor, target, automationArg, sourceArg] = process.argv.slice(2);
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node .github/scripts/ci-host.mjs official|fork VERSION|FORK_PACKAGE AUTOMATION SOURCE\n\nQualifies the once-resolved host with the full package contract and production Git/native install.\nEnvironment: PI_EDITOR_RECEIPT_TEST_ROOT selects the frozen editor checkout. PI_RELEASE_CANDIDATE optionally selects the verified candidate artifact directory; fork qualification also requires PI_RELEASE_FORK to select its prepared host artifact.\nExample: PI_EDITOR_RECEIPT_TEST_ROOT=editor node .github/scripts/ci-host.mjs official 1.0.2 automation extension\nExit codes: 0 passed; 1 invalid input or failed check.",
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

function assertOfficialProvenance(host, expected) {
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
  if (process.env.PI_RELEASE_CANDIDATE) {
    const candidate = resolve(process.env.PI_RELEASE_CANDIDATE);
    const { filename, hosts } = JSON.parse(readFileSync(join(candidate, "release.json"), "utf8"));
    assert.equal(basename(filename), filename, "Candidate filename must be local to the artifact");
    const expected = hosts[flavor];
    assert.ok(expected, `Candidate did not record a ${flavor} host`);
    let candidateHost = host;
    let candidateSelected = selected;
    if (flavor === "fork") {
      assert.ok(
        process.env.PI_RELEASE_FORK,
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
    for (const key of [
      "version",
      "indexSha256",
      "cliSha256",
      "cohort",
      "companions",
      "runtimeLockSha256",
    ]) {
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
