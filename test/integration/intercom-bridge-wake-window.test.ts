import "../support/isolated-home.ts";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { exec } from "../support/intercom-bridge.ts";
import { readJson, record, text } from "../support/assertions.ts";

test("SQLite COMMIT and TLS latency cannot shorten the native POST trailing-hour window", async (t) => {
  const root = mkdtempSync("/tmp/pib-wire-window-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = join(root, "keys");
  await exec(process.execPath, [
    resolve("scripts/intercom-bridge-credentials.mjs"),
    "init",
    keys,
    "wire-window",
    "--cwd",
    root,
  ]);
  const config = record(readJson(join(keys, "config.json")));
  const result = await exec(
    process.execPath,
    [
      resolve("test/fixtures/intercom-wake-window.ts"),
      "window",
      root,
      text(config.cert),
      text(config.key),
    ],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(keys, "ca.crt") } },
  );
  t.diagnostic(result.stdout.split("\n").find((line) => line.includes('"wireSpan"')) ?? "");
});
