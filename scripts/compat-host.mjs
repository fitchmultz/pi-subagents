// Validate the graph prepared by the compatibility runner; never install a host here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hostPackageJson = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
if (hostPackageJson === undefined) {
  throw new Error("Could not locate the installed pi-coding-agent package");
}
export const hostRoot = realpathSync(dirname(hostPackageJson));
export const hostIndex = join(hostRoot, "dist/index.js");
/** @type {{ version: string, bin: { pi: string } }} */
// oxlint-disable-next-line typescript/no-unsafe-assignment
const manifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
export const hostCli = realpathSync(join(hostRoot, manifest.bin.pi));
/** @type {[string, string][]} */
const expectedHostPaths = [
  ["PI_COMPAT_EXPECTED_PACKAGE_DIR", hostRoot],
  ["PI_HOST_INDEX", hostIndex],
  ["PI_HOST_CLI", hostCli],
];
for (const [name, actual] of expectedHostPaths) {
  const expected = process.env[name];
  if (expected !== undefined) {
    assert.equal(
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
      realpathSync(expected),
      realpathSync(actual),
      `${name} must select the installed graph`,
    );
  }
}
const expectedVersion = process.env.PI_COMPAT_EXPECTED_VERSION;
if (expectedVersion !== undefined) {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
  assert.equal(manifest.version, expectedVersion);
}
assert.equal(
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- assert generic inference already matches
  realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  realpathSync(hostIndex),
);
const hash = (/** @type {string} */ path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
console.log(
  JSON.stringify({
    host: process.env.PI_COMPAT_HOST ?? "local",
    version: manifest.version,
    node: process.version,
    hostRoot,
    hostIndex,
    hostCli,
    indexSha256: hash(hostIndex),
    cliSha256: hash(hostCli),
  }),
);
