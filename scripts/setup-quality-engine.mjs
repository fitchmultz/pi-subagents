#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = "eb9339115edde6811ca94c3433adf69ea9852880";
const typescriptRevision = "2bd066d87f5bafd315be9f40889d0a60b9e58e0b";
const patch = join(root, "patches/tsgolint-safe-call.patch");
const readonlyPatch = join(root, "patches/tsgolint-readonly-collections.patch");
const qualifierPatch = join(root, "patches/tsgolint-qualified-readonly.patch");
const cache = join(root, "node_modules/.cache/pi-quality-engine");
const binary = join(cache, "tsgolint");
const manifestPath = join(cache, "manifest.json");
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function prepareSources(source) {
  run("git", ["init", "--quiet"], source);
  run("git", ["remote", "add", "origin", "https://github.com/oxc-project/tsgolint.git"], source);
  run("git", ["fetch", "--depth=1", "origin", revision], source);
  run("git", ["checkout", "--detach", "FETCH_HEAD"], source);
  run("git", ["submodule", "update", "--init", "--depth=1"], source);
  const tsSource = join(source, "typescript-go");
  if (run("git", ["rev-parse", "HEAD"], tsSource) !== typescriptRevision) {
    throw new Error("Unexpected TypeScript submodule revision");
  }
  const upstreamPatches = readdirSync(join(source, "patches"))
    .filter((name) => name.endsWith(".patch"))
    .sort();
  run(
    "git",
    [
      "-c",
      "user.name=quality-engine",
      "-c",
      "user.email=quality-engine@localhost",
      "am",
      "--no-gpg-sign",
      ...upstreamPatches.map((name) => join(source, "patches", name)),
    ],
    tsSource,
  );
  const collections = join(source, "internal/collections");
  mkdirSync(collections, { recursive: true });
  for (const name of readdirSync(join(tsSource, "internal/collections"))) {
    if (name.endsWith(".go") && !name.endsWith("_test.go")) {
      cpSync(join(tsSource, "internal/collections", name), join(collections, name));
    }
  }
  run("git", ["apply", "--check", patch, readonlyPatch, qualifierPatch], source);
  run("git", ["apply", patch, readonlyPatch, qualifierPatch], source);
}

function parseCommand() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node scripts/setup-quality-engine.mjs [--force]\nBuild the pinned declaration-safe and readonly-corrected tsgolint (Git and Go >=1.26 required).\nExample: npm ci --ignore-scripts && node scripts/setup-quality-engine.mjs\nUse OXLINT_TSGOLINT_PATH=node_modules/.cache/pi-quality-engine/tsgolint with Oxlint.",
    );
    return;
  }
  if (args.some((arg) => arg !== "--force")) {
    throw new Error("Unknown argument. Use --help for usage.");
  }
  return args.includes("--force");
}

function setup() {
  const force = parseCommand();
  if (force === undefined) {
    return;
  }
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
    throw new Error(`Unsupported build host: ${process.platform}/${process.arch}`);
  }
  const identity = {
    revision,
    typescriptRevision,
    patchSha256: digest(patch),
    readonlyPatchSha256: digest(readonlyPatch),
    qualifierPatchSha256: digest(qualifierPatch),
    platform: process.platform,
    arch: process.arch,
  };
  if (!force && existsSync(manifestPath) && existsSync(binary)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      Object.entries(identity).every(([key, value]) => manifest[key] === value) &&
      manifest.binarySha256 === digest(binary)
    ) {
      console.log(`Corrected quality engine ready: ${binary}`);
      return;
    }
  }
  const goVersion = run("go", ["version"], root);
  mkdirSync(cache, { recursive: true });
  const source = mkdtempSync(join(tmpdir(), "pi-quality-engine-"));
  const output = join(source, "tsgolint");
  try {
    prepareSources(source);
    run(
      "go",
      [
        "build",
        "-mod=readonly",
        "-buildvcs=false",
        "-ldflags=-s -w",
        "-trimpath",
        "-o",
        output,
        "./cmd/tsgolint",
      ],
      source,
      {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: process.platform,
        GOARCH: process.arch === "x64" ? "amd64" : "arm64",
      },
    );
    const manifest = { ...identity, goVersion, binarySha256: digest(output) };
    // Stage beside the destination so publication also works across filesystems.
    cpSync(output, join(cache, "tsgolint.next"));
    renameSync(join(cache, "tsgolint.next"), binary);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Built corrected quality engine: ${binary}`);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

try {
  setup();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
