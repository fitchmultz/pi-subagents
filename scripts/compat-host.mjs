// Validate the graph prepared by the compatibility runner; never install a host here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const hostRoot = realpathSync(dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)));
export const hostIndex = join(hostRoot, "dist/index.js");
const manifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
export const hostCli = realpathSync(join(hostRoot, manifest.bin.pi));
for (const [name, actual] of [["PI_COMPAT_EXPECTED_PACKAGE_DIR", hostRoot], ["PI_HOST_INDEX", hostIndex], ["PI_HOST_CLI", hostCli]]) {
  if (process.env[name]) assert.equal(realpathSync(process.env[name]), realpathSync(actual), `${name} must select the installed graph`);
}
if (process.env.PI_COMPAT_EXPECTED_VERSION) assert.equal(manifest.version, process.env.PI_COMPAT_EXPECTED_VERSION);
assert.equal(realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), realpathSync(hostIndex));
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
console.log(JSON.stringify({ host: process.env.PI_COMPAT_HOST ?? "local", version: manifest.version, node: process.version, hostRoot, hostIndex, hostCli, indexSha256: hash(hostIndex), cliSha256: hash(hostCli) }));
