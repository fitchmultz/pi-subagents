import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { readJson } from "../support/assertions.ts";
import { Type } from "typebox";
import { Assert } from "typebox/value";

const evidenceSchema = Type.Object({
  failures: Type.Array(Type.String()),
  nativeProviderRequests: Type.Number(),
  checks: Type.Array(Type.String()),
});
function readEvidence(file: string) {
  const value = readJson(file);
  Assert(evidenceSchema, value);
  return value;
}
interface RoutingPhase {
  readonly phase: string;
  readonly status: number | null;
  readonly stderr: string;
  readonly evidence: {
    readonly failures: readonly string[];
    readonly nativeProviderRequests: number;
    readonly checks: readonly string[];
  };
}
function saveRoutingEvidence(root: string, log: string, results: readonly RoutingPhase[]): void {
  fs.writeFileSync(path.join(root, "broker.log"), log);
  fs.writeFileSync(path.join(root, "routing-evidence.json"), JSON.stringify(results, null, 2));
  const requested = process.env.PI_OWNERSHIP_KEEP_EVIDENCE;
  if ((requested !== undefined && requested !== "") || results.length !== 4) {
    console.log(`Native result routing evidence: ${root}/routing-evidence.json`);
  } else {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function startPrivateBroker(repo: string, root: string, env: Readonly<NodeJS.ProcessEnv>) {
  const keeper = new IntercomClient();
  const broker = spawn(process.execPath, [path.join(repo, "dist/pi-intercom/broker/broker.js")], {
    env,
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  broker.stdout.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  broker.stderr.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  const exited = once(broker, "exit");
  const stop = async () => {
    await keeper.disconnect();
    if (broker.exitCode === null && broker.signalCode === null) {
      broker.kill("SIGTERM");
    }
    await exited;
  };
  try {
    const deadline = Date.now() + 5_000;
    while (!log.includes("Intercom broker started")) {
      assert.ok(Date.now() < deadline, log.length > 0 ? log : "Private broker did not start");
      // Process readiness precedes the keeper admission and every dependent native phase.
      // oxlint-disable-next-line no-await-in-loop
      await sleep(20);
    }
    // Cold SDK startup can exceed the broker's idle lifetime between phases.
    await keeper.connect({ name: "fixture-host", cwd: root, model: "fixture" });
    return { stop, log: () => log };
  } catch (error) {
    await stop();
    throw error;
  }
}

it(
  "native restarted owners route async results to their current intercom identity; foreign owners stay excluded and fallback stays quiet",
  { timeout: 100_000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-result-routing-"));
    const repo = fileURLToPath(new URL("../../", import.meta.url));
    const packageRoot =
      process.env.PI_OWNERSHIP_TEST_PACKAGE_ROOT ??
      path.dirname(
        path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
      );
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("PI_SUBAGENT_") || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) {
        delete env[key];
      }
    }
    Object.assign(env, {
      HOME: root,
      TMPDIR: root,
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
      PI_SUBAGENT_TEMP_ROOT: path.join(root, "pi-subagents-runtime"),
      PI_OFFLINE: "1",
      JITI_FS_CACHE: path.join(root, "jiti"),
    });
    const previousEnv = { ...process.env };
    Object.assign(process.env, { TMPDIR: root, PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR });
    t.after(() => {
      process.env = previousEnv;
    });
    const broker = await startPrivateBroker(repo, root, env);
    const results: RoutingPhase[] = [];
    try {
      for (const phase of ["seed", "foreign", "resume", "fallback"]) {
        if (phase === "fallback") {
          // Complete the previous native broker phase before exercising unavailable routing.
          // oxlint-disable-next-line no-await-in-loop
          await broker.stop();
          // A genuinely unavailable private broker exercises the existing durable error path.
          fs.writeFileSync(
            path.join(root, "agent/intercom/config.json"),
            JSON.stringify({ brokerCommand: path.join(root, "unavailable-broker") }),
          );
        }
        const child = spawnSync(
          process.execPath,
          [
            path.join(repo, "test/fixtures/native-result-routing.mjs"),
            root,
            repo,
            packageRoot,
            phase,
          ],
          { cwd: repo, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
        );
        fs.writeFileSync(path.join(root, `${phase}.stdout`), child.stdout);
        fs.writeFileSync(path.join(root, `${phase}.stderr`), child.stderr);
        assert.equal(child.error, undefined, `${phase}: ${child.error?.message ?? ""}`);
        const evidence = readEvidence(path.join(root, `${phase}-evidence.json`));
        results.push({ phase, status: child.status, stderr: child.stderr, evidence });
        if (phase === "seed") {
          assert.equal(child.status, 0, child.stdout.length > 0 ? child.stdout : child.stderr);
        }
      }
      await Promise.all(
        results.map((result) =>
          t.test(result.phase, () => {
            assert.equal(
              result.status,
              0,
              `${result.phase}: ${result.evidence.failures.join("\n")}`,
            );
            assert.deepEqual(result.evidence.failures, []);
            assert.equal(result.evidence.nativeProviderRequests, 0);
            assert.equal(
              result.stderr,
              "",
              `${result.phase}: grouped delivery/fallback must not print over the editor`,
            );
          }),
        ),
      );
    } finally {
      // Release only this fixture's children if setup failed before the normal gates.
      if (fs.existsSync(path.join(root, "calls"))) {
        for (const name of ["foreign", "repaired", "fallback"]) {
          fs.writeFileSync(path.join(root, "calls", `release_${name}`), "release");
        }
      }
      await broker.stop();
      saveRoutingEvidence(root, broker.log(), results);
    }
  },
);
