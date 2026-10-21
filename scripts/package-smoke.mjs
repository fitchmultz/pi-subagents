#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostRoot } from "./compat-host.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: node scripts/package-smoke.mjs\n\nPack and install the single-entry package without development dependencies. Verify host SDK/TypeBox identity and execute a real native actor using a credential-free local provider. No publication or paid model calls.\nExit codes: 0 passed; 1 packaging, native execution or cleanup failed.",
  );
  process.exit(0);
}

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const root = mkdtempSync(join(tmpdir(), "ps-package-"));
const packDir = join(root, "pack");
mkdirSync(packDir);

function run(command, args, cwd = process.cwd(), env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function verifyManifest(manifest) {
  assert.equal(manifest.name, "@fitchmultz/pi-subagents");
  assert.notEqual(manifest.private, true);
  assert.deepEqual(manifest.publishConfig, { access: "public" });
  assert.equal(manifest.bin, undefined, "no legacy installer");
  assert.deepEqual(manifest.pi.extensions, ["./dist/index.js"]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.equal(manifest.pi.agents, undefined);
  assert.equal(manifest.pi.prompts, undefined);
}

function installProduction(pack) {
  const installDir = join(root, "npm");
  mkdirSync(installDir);
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--legacy-peer-deps",
      join(packDir, pack.filename),
    ],
    installDir,
  );
  const installed = join(installDir, "node_modules", packageJson.name);
  const standalone = join(root, "standalone");
  cpSync(installed, standalone, { recursive: true });
  run("npm", ["install", "--ignore-scripts", "--omit=dev", "--legacy-peer-deps"], standalone);
  for (const directory of [join(installDir, "node_modules"), join(standalone, "node_modules")]) {
    for (const name of [
      "typescript",
      "typebox",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ]) {
      assert.equal(
        existsSync(join(directory, name)),
        false,
        `runtime-only installation shadows host dependency ${name}`,
      );
    }
  }
  return [installed, standalone];
}

async function verifyRuntime(packageRoot) {
  verifyManifest(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")));
  const hostRequire = createRequire(join(hostRoot, "dist/index.js"));
  const sdk = await import(pathToFileURL(join(hostRoot, "dist/index.js")).href);
  const nativeHost = await import(pathToFileURL(join(packageRoot, "dist/agent/host.js")).href);
  assert.equal(
    await nativeHost.loadSDK(hostRoot),
    sdk,
    "actor must use the exact selected host SDK",
  );
  const hostTypebox = await import(pathToFileURL(hostRequire.resolve("typebox")).href);
  const nativeTypebox = await import(
    pathToFileURL(join(packageRoot, "dist/agent/typebox.js")).href
  );
  assert.equal(nativeTypebox.Type, hostTypebox.Type, "shared schemas use the selected host");
  const broker = await import(
    pathToFileURL(join(packageRoot, "dist/pi-intercom/broker/spawn.js")).href
  );
  assert.equal(realpathSync(broker.getBrokerSpawnOptions().cwd), realpathSync(packageRoot));
  const help = run(
    process.execPath,
    [join(packageRoot, "scripts/intercom-bridge-credentials.mjs"), "--help"],
    root,
  );
  assert.match(help, /Usage: node scripts\/intercom-bridge-credentials.mjs/);
  process.stdout.write(
    run(
      process.execPath,
      [fileURLToPath(new URL("./native-package-smoke.mjs", import.meta.url)), packageRoot],
      root,
      { ...process.env, PI_PACKAGE_DIR: hostRoot, PATH: "/usr/bin:/bin" },
    ),
  );
}

try {
  verifyManifest(packageJson);
  process.env.PI_PACKAGE_DIR = hostRoot;
  const pack = Object.values(
    JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir])),
  )[0];
  assert.ok(pack && Array.isArray(pack.files), "npm pack must report files");
  const paths = new Set(pack.files.map((file) => file.path));
  for (const path of [
    "package.json",
    "LICENSE",
    "README.md",
    "dist/index.js",
    "dist/build-info.js",
    "dist/agent/runner.js",
    "dist/pi-intercom/broker/broker.js",
    "dist/pi-intercom/bridge.js",
    "src/index.ts",
    "src/agent/index.ts",
    "scripts/prepare.mjs",
    "scripts/build.mjs",
    "scripts/real-pi-smoke.mjs",
    "scripts/intercom-remote.mjs",
    "skills/pi-subagents/SKILL.md",
    "skills/pi-intercom/SKILL.md",
  ]) {
    assert.ok(paths.has(path), `npm pack is missing ${path}`);
  }
  for (const path of paths) {
    assert.doesNotMatch(
      path,
      /^(?:agents|prompts|generated)\//,
      "no profiles, prompt templates or old generated validators",
    );
    assert.notEqual(path, "dist/extension/index.js", "retired orchestration entry must not ship");
    assert.notEqual(path, "install.mjs", "no legacy installer");
  }
  for (const packageRoot of installProduction(pack)) {
    // Qualify both the npm node_modules location and standalone git-style production graph.
    // oxlint-disable-next-line no-await-in-loop
    await verifyRuntime(packageRoot);
  }
  console.log(
    `[package-smoke] ${pack.name}@${pack.version}: ${pack.files.length} files; one entry, zero profiles/prompts; runtime-only npm and standalone native actors passed`,
  );
} catch (error) {
  console.error(`[package-smoke] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
