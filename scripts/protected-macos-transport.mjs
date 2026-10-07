import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

function diagnostic(result, options) {
  const clean = (text) => {
    if (options.sensitive) {
      return "[credential-bearing command output omitted]";
    }
    let value = String(text ?? "");
    for (const secret of options.secrets ?? []) {
      value = value.replaceAll(secret, "[secret omitted]");
    }
    return value.slice(0, 65536);
  };
  return {
    status: result.status,
    signal: result.signal,
    code: result.error?.code,
    stdout: clean(result.stdout),
    stderr: clean(result.stderr),
  };
}
export function execute(command, args, options = {}) {
  const { diagnosticPath, sensitive, secrets, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
    ...spawnOptions,
  });
  if (result.error || result.status !== 0) {
    const detail = diagnostic(result, { sensitive, secrets });
    if (diagnosticPath) {
      writeFileSync(diagnosticPath, JSON.stringify(detail, null, 2), { mode: 0o600 });
    }
    const error =
      result.error ??
      new Error(
        `${command} failed (exit ${result.status ?? "unavailable"}); private diagnostics retained`,
      );
    error.diagnostic = detail;
    throw error;
  }
  return result.stdout;
}
export async function observeReadiness(observe, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (!observe()) {
    assert.ok(Date.now() < deadline, `Timed out observing ${description}`);
    // Each actual observation finishes before the next dependent retry.
    // oxlint-disable-next-line no-await-in-loop
    await delay(1000);
  }
}
