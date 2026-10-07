import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Native calls run in one ordinary Node helper, never inline in a cleanup
// owner. SIGKILL preemption/reaping remains at the real subprocess boundary.
export function darwinSnapshot(token, pid, deadline, identityOnly = false) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Owned-process cleanup observation exceeded its deadline");
  }
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./compat-process-query.mjs", import.meta.url))],
    {
      input: JSON.stringify({ token, pid, deadline, identityOnly }),
      encoding: "utf8",
      timeout: Math.min(remaining, 3000),
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(result.error.message, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(
      `Native query failed (${result.status ?? result.signal}): ${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}
