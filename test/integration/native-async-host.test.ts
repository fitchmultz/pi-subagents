import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPackageJSON } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Assert } from "typebox/value";
import { assertDefined } from "../support/assertions.ts";

const evidenceSchema = Type.Object({
  networkRequests: Type.Number(),
  errors: Type.Array(Type.Unknown()),
  entries: Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.String(),
        customType: Type.Optional(Type.String()),
        data: Type.Optional(Type.Object({ delivery: Type.Optional(Type.Unknown()) })),
      }),
    ),
  ),
});
function readEvidence(file: string) {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  Assert(evidenceSchema, value);
  return value;
}
function failureMessage(result: {
  readonly stderr: string;
  readonly stdout: string;
  readonly error?: Readonly<Error>;
}): string {
  if (result.stderr.length > 0) {
    return result.stderr;
  }
  if (result.stdout.length > 0) {
    return result.stdout;
  }
  return result.error?.message ?? "Native child failed";
}

const repo = fileURLToPath(new URL("../../", import.meta.url));
const sdkPackage = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
assertDefined(sdkPackage);
const sdkRoot = process.env.PI_NATIVE_ASYNC_TEST_SDK ?? path.dirname(sdkPackage);
const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-native-suite-"));
Object.assign(process.env, {
  HOME: suiteRoot,
  PI_CODING_AGENT_DIR: path.join(suiteRoot, "agent"),
  PI_PACKAGE_DIR: sdkRoot,
  PI_SUBAGENT_TEMP_ROOT: path.join(suiteRoot, "pi-subagents-runtime"),
  PI_OFFLINE: "1",
});
for (const [phase, title] of [
  ["portable-child", "persists nested usage once"],
  ["portable-child-control", "keeps its wait attached during interruption"],
]) {
  test(`child-safe delegation ${title} through the native host`, { timeout: 40_000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-native-child-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(repo, "test/fixtures/native-async-parent.mjs"),
          root,
          repo,
          sdkRoot,
          phase,
          "nested",
        ],
        { cwd: repo, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      );
      assert.equal(result.status, 0, failureMessage(result));
      const evidence = readEvidence(path.join(root, `${phase}-evidence.json`));
      assert.equal(evidence.networkRequests, 0);
      assert.deepEqual(evidence.errors, []);
    } finally {
      fs.writeFileSync(path.join(root, "release-child"), "release");
      console.log(`Native nested usage evidence: ${root}`);
    }
  });
}
for (const variant of ["receipt", "advanced-receipt", "child-restart", "advanced-child-restart"]) {
  test(`native ${variant} closes before background completion`, { timeout: 40_000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-native-receipt-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(repo, "test/fixtures/native-async-parent.mjs"),
          root,
          repo,
          sdkRoot,
          "receipt",
          variant,
        ],
        { cwd: repo, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
      );
      assert.equal(result.status, 0, failureMessage(result));
      const evidence = readEvidence(path.join(root, "receipt-evidence.json"));
      assert.equal(evidence.networkRequests, 0);
      assert.deepEqual(evidence.errors, []);
    } finally {
      fs.writeFileSync(path.join(root, "release-child"), "release");
      console.log(`Native receipt evidence: ${root}`);
    }
  });
}
for (const variant of ["receipt", "child-restart"]) {
  for (const crashAt of [undefined, "before", "after"]) {
    test(
      `native background ${variant} completion survives ${crashAt !== undefined ? `crash ${crashAt} notification append` : "owner restart"} exactly once`,
      { timeout: 60_000 },
      async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-receipt-restart-"));
        try {
          for (const phase of [
            "receipt-seed",
            ...(crashAt !== undefined ? [`receipt-crash-${crashAt}`] : []),
            "receipt-resume",
            "receipt-reopen",
          ]) {
            const result = spawnSync(
              process.execPath,
              [
                path.join(repo, "test/fixtures/native-async-parent.mjs"),
                root,
                repo,
                sdkRoot,
                phase,
                variant,
              ],
              { cwd: repo, encoding: "utf8", timeout: 25_000, maxBuffer: 2 * 1024 * 1024 },
            );
            assert.equal(
              result.status,
              phase.startsWith("receipt-crash-") ? 86 : 0,
              `${phase}: ${failureMessage(result)}`,
            );
            const evidence = readEvidence(
              path.join(
                root,
                phase.startsWith("receipt-crash-")
                  ? "crash-evidence.json"
                  : `${phase}-evidence.json`,
              ),
            );
            assert.equal(evidence.networkRequests, 0);
            assert.deepEqual(evidence.errors, []);
            if (phase.startsWith("receipt-crash-")) {
              assert.ok(evidence.entries, "native crash evidence includes the journal");
              assert.equal(
                evidence.entries.filter(
                  (entry) =>
                    entry.type === "custom_message" && entry.customType === "subagent-notify",
                ).length,
                crashAt === "after" ? 1 : 0,
              );
              assert.ok(
                !evidence.entries.some(
                  (entry) =>
                    entry.type === "custom" &&
                    entry.customType === "subagent-run" &&
                    Boolean(entry.data?.delivery),
                ),
                "no delivery claim may precede the persisted notification",
              );
            }
            if (phase === "receipt-seed") {
              fs.writeFileSync(path.join(root, "release-child"), "release");
              const seed: unknown = JSON.parse(
                fs.readFileSync(path.join(root, "seed.json"), "utf8"),
              );
              Assert(Type.Object({ runId: Type.String() }), seed);
              const deadline = Date.now() + 10_000;
              while (
                !fs.existsSync(
                  path.join(root, "agent/sessions/subagent-runs", seed.runId, "result.json"),
                )
              ) {
                assert.ok(Date.now() < deadline, "child must finish while its parent is offline");
                // Poll the persisted result while the native owner is offline.
                // oxlint-disable-next-line no-await-in-loop
                await delay(20);
              }
            }
          }
        } finally {
          fs.writeFileSync(path.join(root, "release-child"), "release");
          console.log(`Native receipt restart evidence: ${root}`);
        }
      },
    );
  }
}
