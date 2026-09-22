// Reuse existing native contracts. The full replay suite additionally requires fork queue/newContext semantics.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRoot } from "./compat-host.mjs";

const root = mkdtempSync(join(tmpdir(), "ps-compat-"));
const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, ".pi", "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_PACKAGE_DIR: hostRoot,
  PI_INTERCOM_TEST_SDK: hostRoot, PI_OWNERSHIP_TEST_PACKAGE_ROOT: hostRoot, PI_CONTEXT_TEST_PACKAGE_ROOT: hostRoot };
for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_")) delete env[key];
env.PI_SUBAGENT_TEMP_ROOT = join(root, "pi-subagents-runs");
const fork = process.env.PI_COMPAT_HOST === "fork";
if (fork) Object.assign(env, { PI_CHECKPOINT_TEST_SDK: hostRoot, PI_CHECKPOINT_TEST_REQUIRED: "1" });
else { delete env.PI_CHECKPOINT_TEST_SDK; delete env.PI_CHECKPOINT_TEST_REQUIRED; }
const contracts = ["native-context-contract", "native-same-cwd-resume", "native-acceptance-cli", "native-structured-output", "native-run-ownership", "native-result-routing", "native-tool-results", "tool-activation"];
try {
  // Allow the full suite to drain on slower hosted runners; individual test deadlines are unchanged.
  const args = fork ? ["scripts/run-tests.mjs", "integration", "--timeout-ms", "900000"] : ["--test", "--test-concurrency=2", ...contracts.map(name => `test/integration/${name}.test.ts`)];
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit", timeout: fork ? 930_000 : 390_000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
