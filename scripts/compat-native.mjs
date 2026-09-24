// Official hosts run portable contracts; the external fleet shards the full fork suite.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { hostRoot } from "./compat-host.mjs";

const fork = process.env.PI_COMPAT_HOST === "fork";
const ci = process.env.CI === "true";
const core = process.argv[2] === "--core" && process.argv.length === 3;
if (process.argv.length > 2 && !core) throw new Error("Usage: node scripts/compat-native.mjs [--core]");
if (core && (!ci || !fork)) throw new Error("--core requires the fork CI host");
const root = mkdtempSync(join(tmpdir(), "ps-compat-"));
const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, ".pi", "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_PACKAGE_DIR: hostRoot,
  PI_INTERCOM_TEST_SDK: hostRoot, PI_OWNERSHIP_TEST_PACKAGE_ROOT: hostRoot, PI_CONTEXT_TEST_PACKAGE_ROOT: hostRoot };
for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_")) delete env[key];
env.PI_SUBAGENT_TEMP_ROOT = join(root, "pi-subagents-runs");
// These are the three fork lanes in the shared compatibility matrix.
const shard = ci && fork && !core ? { "linux:22": "1/3", "linux:24": "2/3", "darwin:24": "3/3" }[`${process.platform}:${process.versions.node.split(".")[0]}`] : undefined;
if (ci && fork && !core && !shard) throw new Error("No integration shard assigned to this fork CI lane");
if (fork) {
  Object.assign(env, { PI_CHECKPOINT_TEST_SDK: hostRoot, PI_CHECKPOINT_TEST_REQUIRED: "1" });
  delete env.PI_CODING_AGENT_DIR; // Fork fixtures deliberately substitute HOME, as run-tests.mjs does.
}
else { delete env.PI_CHECKPOINT_TEST_SDK; delete env.PI_CHECKPOINT_TEST_REQUIRED; }
const contracts = ["native-context-contract", "native-same-cwd-resume", "native-acceptance-cli", "native-structured-output", "native-run-ownership", "native-completion-ownership", "native-result-routing", "native-tool-results", "tool-activation"];
const coreFiles = [
  "native-checkpoint-idle", "pi-intercom-native-replay", "native-async-host", "native-completion-ownership", "parent-usage",
  "async-execution", "parallel-execution", "chain-execution", "intercom-result-delivery",
  "owned-result-retention", "process-lifecycle", "orphan-stop", "real-pi-smoke-cleanup",
];
if (core) Object.assign(env, { PI_NATIVE_ASYNC_TEST_SDK: hostRoot, PI_NATIVE_ASYNC_REQUIRE_HOST: "1", PI_PARENT_USAGE_TEST_SDK: hostRoot, PI_PARENT_USAGE_REQUIRE_NATIVE: "1" });
try {
  const files = core ? coreFiles.map(name => `test/integration/${name}.test.ts`) : fork
    ? readdirSync("test/integration").filter(name => name.endsWith(".test.ts")).sort().map(name => `test/integration/${name}`)
    : contracts.map(name => `test/integration/${name}.test.ts`);
  const checks = core || !ci || shard === "2/3"
    ? [["scripts/run-tests.mjs", "unit"], ["scripts/package-smoke.mjs"], ["scripts/local-install-smoke.mjs"]]
    : [["scripts/native-package-smoke.mjs"]];
  checks.push(["--test", `--test-concurrency=${Math.min(4, Math.max(1, availableParallelism() - 1))}`, ...(shard ? [`--test-shard=${shard}`] : []), ...files]);
  console.log(`[compat-native] ${core ? "core fork contracts" : shard ? `integration shard ${shard}` : fork ? "full integration suite" : "portable host contracts"}`);
  for (const args of checks) {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit", timeout: fork && !shard && !core ? 930_000 : 330_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(`[compat-native] ${args.join(" ")} exited ${result.status ?? "without status"}${result.signal ? ` (${result.signal})` : ""}`);
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
