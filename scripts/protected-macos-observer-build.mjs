import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execute } from "./protected-macos-transport.mjs";

const inputs = [
  "protected-macos-observer-build.mjs",
  "protected-macos-quiescence.c",
  "protected-macos-prejob.h",
  "protected-macos-arguments.h",
  "protected-macos-files.h",
  "protected-macos-runner-inputs.h",
  "protected-macos-sockets.h",
  "protected-macos-lifecycle.h",
  "protected-macos-lifecycle-es.h",
  "protected-macos-lifecycle-publication.h",
  "protected-macos-source-identity.h",
  "protected-macos-runner-integrity.tsv",
  "protected-macos-job-started.sh",
  "protected-macos-runner-launch.sh",
];
export function observerInputs() {
  const files = inputs.map((name) => {
    const path = new URL(name, import.meta.url);
    return {
      name,
      mode: statSync(path).mode & 0o777,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  });
  return {
    files,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}
function build(directory) {
  const output = resolve(directory);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const sdk = execute("/usr/bin/xcrun", ["--show-sdk-path"]).trim();
  const sdkVersion = execute("/usr/bin/xcrun", ["--show-sdk-version"]).trim();
  assert.ok(Number.parseInt(sdkVersion, 10) >= 27, "Descendants observer requires macOS SDK 27+");
  const args = [
    "-Wall",
    "-Werror",
    "-Wno-deprecated-declarations",
    "-fblocks",
    "-mmacosx-version-min=13.0",
    "-isysroot",
    sdk,
    fileURLToPath(new URL("protected-macos-quiescence.c", import.meta.url)),
    "-lEndpointSecurity",
    "-lbsm",
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    "-o",
    join(output, "observer-unsigned"),
  ];
  execute("/usr/bin/clang", args);
  writeFileSync(
    join(output, "observer-inputs.json"),
    JSON.stringify({ version: 1, source: observerInputs(), sdk, sdkVersion, args }, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log("Compiled unsigned source only; NOT installable or EndpointSecurity-qualified.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    console.log(
      "Usage: node scripts/protected-macos-observer-build.mjs OUTPUT_DIRECTORY\n" +
        "Example: node scripts/protected-macos-observer-build.mjs /tmp/protected-observer-build\n" +
        "Compiles unsigned API-compatible source and exact input manifest. Does not sign, create\n" +
        "an ES client, grant access, install or activate. Exit 0 built/help; 1 failure; 2 usage.",
    );
  } else if (args.length === 1) {
    try {
      assert.equal(process.platform, "darwin");
      build(args[0]);
    } catch (error) {
      console.error(error.diagnostic?.stderr || error.message);
      process.exitCode = 1;
    }
  } else {
    console.error("Expected output directory; use --help.");
    process.exitCode = 2;
  }
}
