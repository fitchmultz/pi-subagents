// Official hosts run portable contracts; the fork CI lanes share one complete integration suite.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { hostRoot } from "./compat-host.mjs";

const root = mkdtempSync(join(tmpdir(), "ps-compat-"));
const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, ".pi", "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_PACKAGE_DIR: hostRoot,
  PI_INTERCOM_TEST_SDK: hostRoot, PI_OWNERSHIP_TEST_PACKAGE_ROOT: hostRoot, PI_CONTEXT_TEST_PACKAGE_ROOT: hostRoot };
for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_")) delete env[key];
env.PI_SUBAGENT_TEMP_ROOT = join(root, "pi-subagents-runs");
const fork = process.env.PI_COMPAT_HOST === "fork";
const ci = process.env.CI === "true";
// These are the three fork lanes in the shared compatibility matrix.
const shard = ci && fork ? { "linux:22": "1/3", "linux:24": "2/3", "darwin:24": "3/3" }[`${process.platform}:${process.versions.node.split(".")[0]}`] : undefined;
if (ci && fork && !shard) throw new Error("No integration shard assigned to this fork CI lane");
if (fork) {
  Object.assign(env, { PI_CHECKPOINT_TEST_SDK: hostRoot, PI_CHECKPOINT_TEST_REQUIRED: "1" });
  delete env.PI_CODING_AGENT_DIR; // Fork fixtures deliberately substitute HOME, as run-tests.mjs does.
}
else { delete env.PI_CHECKPOINT_TEST_SDK; delete env.PI_CHECKPOINT_TEST_REQUIRED; }
const contracts = ["native-context-contract", "native-same-cwd-resume", "native-acceptance-cli", "native-structured-output", "native-run-ownership", "native-result-routing", "native-tool-results", "tool-activation"];
try {
  const files = fork
    ? readdirSync("test/integration").filter(name => name.endsWith(".test.ts")).sort().map(name => `test/integration/${name}`)
    : contracts.map(name => `test/integration/${name}.test.ts`);
  const checks = !ci || shard === "2/3"
    ? [["scripts/run-tests.mjs", "unit"], ["scripts/package-smoke.mjs"], ["scripts/local-install-smoke.mjs"]]
    : [["scripts/native-package-smoke.mjs"]];
  checks.push(["--test", `--test-concurrency=${Math.min(4, Math.max(1, availableParallelism() - 1))}`, ...(shard ? [`--test-shard=${shard}`] : []), ...files]);
  console.log(`[compat-native] ${shard ? `integration shard ${shard}` : fork ? "full integration suite" : "portable host contracts"}`);
  for (const args of checks) {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit", timeout: fork && !shard ? 930_000 : 330_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
