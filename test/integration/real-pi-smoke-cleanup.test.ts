import { assertDefined, parseJson, record, text, numberValue } from "../support/assertions.ts";
import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isChildTreeAlive, trySignalChildTree } from "../../src/shared/post-exit-stdio-guard.ts";

const script =
  process.env.PI_REAL_SMOKE_TEST_SCRIPT ??
  fileURLToPath(new URL("../../scripts/real-pi-smoke.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/real-pi-smoke-cli.mjs", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));

const processRef = (pid: number) => ({
  pid,
  kill: (signal: NodeJS.Signals | number = 0) => process.kill(pid, signal),
});
const eventsAt = (root: string) =>
  existsSync(join(root, "events.jsonl"))
    ? readFileSync(join(root, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const event = record(parseJson(line));
          return {
            event: text(event.event),
            role: text(event.role),
            pid: numberValue(event.pid),
            auth: event.auth,
            models: event.models,
            artifacts: event.artifacts,
            kind: event.kind,
          };
        })
    : [];
async function until(check: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, "fixture did not finish before its watchdog");
    // Observe the owner publication before advancing this lifecycle transition.
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}

// The same test runs unchanged against the original and repaired scripts via PI_REAL_SMOKE_TEST_SCRIPT.
test(
  "real smoke stops its owned detached processes before deleting credentials and artifacts",
  { skip: process.platform === "win32", timeout: 100_000 },
  async (t) => {
    for (const name of [
      "timeout",
      "startup-timeout",
      "failure",
      "startup-failure",
      "SIGINT",
      "SIGTERM",
      "async-failure",
      "async-timeout",
      "success",
      "success-clean",
    ]) {
      const scenario = name === "success-clean" ? "success" : name;
      // Each scenario owns shared fixture state; complete it before starting the next one.
      // oxlint-disable-next-line no-await-in-loop
      await t.test(name, async () => {
        const root = mkdtempSync(
          join(process.env.PI_REAL_SMOKE_TEST_ROOT ?? tmpdir(), "pi-subagents-smoke-cleanup-"),
        );
        const auth = join(root, "dummy-auth");
        const bin = join(root, "bin");
        for (const directory of [auth, bin, join(root, "tmp"), join(root, "home")]) {
          mkdirSync(directory, { recursive: true });
        }
        for (const name of ["auth.json", "models.json"]) {
          writeFileSync(join(auth, name), '{"fixture":"not-a-credential"}\n', { mode: 0o600 });
        }
        writeFileSync(
          join(bin, "pi"),
          `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
          { mode: 0o700 },
        );
        let controller: ChildProcess | undefined;
        let output = "";
        let closed = false;
        let code: number | null = null;
        let smokeRoot: string | undefined;
        let prematureRemoval = false;
        const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore",
          env: {},
        });
        try {
          controller = spawn(
            process.execPath,
            [
              script,
              scenario === "success" ? "--llm-full" : "--llm",
              ...(name === "success-clean" ? [] : ["--keep-temp"]),
              "--timeout-ms",
              scenario === "success" || scenario === "startup-failure" || scenario.startsWith("SIG")
                ? "10000"
                : "1000",
            ],
            {
              cwd: repo,
              env: {
                HOME: join(root, "home"),
                TMPDIR: join(root, "tmp"),
                PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
                PI_REAL_SMOKE_AUTH_AGENT_DIR: auth,
                PI_REAL_SMOKE_MODEL: "fixture/smoke",
                PI_OFFLINE: "1",
                PI_TELEMETRY: "0",
                SMOKE_CLEANUP_EVIDENCE: root,
                SMOKE_CLEANUP_SCENARIO: scenario,
              },
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const defined4438_0 = controller.stdout;
          assertDefined(defined4438_0);
          defined4438_0.on("data", (chunk) => {
            output += chunk;
          });
          const defined4534_0 = controller.stderr;
          assertDefined(defined4534_0);
          defined4534_0.on("data", (chunk) => {
            output += chunk;
          });
          controller.on("close", (exitCode) => {
            code = exitCode;
            closed = true;
          });
          await until(() => existsSync(join(root, "parent-ready")) || closed);
          assert.ok(
            existsSync(join(root, "parent-ready")),
            "fixture must reach detached launch, not merely fail startup",
          );
          smokeRoot = text(
            record(parseJson(readFileSync(join(root, "install.json"), "utf8"))).root,
          );
          const defined5078_0 = smokeRoot;
          assertDefined(defined5078_0);
          const copiedAuth = join(defined5078_0, "pi-agent", "auth.json");
          const defined5150_0 = smokeRoot;
          assertDefined(defined5150_0);
          const copiedModels = join(defined5150_0, "pi-agent", "models.json");
          const ready = record(parseJson(readFileSync(join(root, "parent-ready"), "utf8")));
          assert.ok(
            ready.auth === true && ready.models === true,
            "dummy credentials were copied before the failure",
          );
          if (scenario.startsWith("SIG")) {
            controller.kill(scenario as NodeJS.Signals);
            await delay(20);
            if (!closed) {
              controller.kill(scenario as NodeJS.Signals);
            }
          }
          await until(() => {
            const owned = eventsAt(root).filter((event) => event.event === "started");
            if (
              (!existsSync(copiedAuth) || !existsSync(copiedModels)) &&
              owned.some((event) => isChildTreeAlive(processRef(numberValue(event.pid))))
            ) {
              prematureRemoval = true;
            }
            return closed;
          });
          const owned = eventsAt(root).filter((event) => event.event === "started");
          const liveAtExit = owned
            .filter((event) => isChildTreeAlive(processRef(numberValue(event.pid))))
            .map((event) => event.role);
          const writeAt = numberValue(
            record(parseJson(readFileSync(join(root, "child-ready"), "utf8"))).writeAt,
          );
          if (scenario !== "success") {
            await delay(Math.max(0, writeAt + 100 - Date.now()));
          }
          assert.equal(
            existsSync(join(root, "delayed-child-write")),
            false,
            "a detached child wrote after the controller returned",
          );
          assert.deepEqual(
            liveAtExit,
            [],
            "controller returned while smoke-owned processes were still alive",
          );
          assert.equal(
            prematureRemoval,
            false,
            "copied credentials disappeared before owned process exit",
          );
          assert.equal(
            existsSync(copiedAuth) || existsSync(copiedModels),
            false,
            "--keep-temp must still remove copied credentials",
          );
          const defined7176_0 = smokeRoot;
          assertDefined(defined7176_0);
          assert.equal(
            existsSync(defined7176_0),
            name !== "success-clean",
            "only --keep-temp preserves noncredential evidence",
          );
          assert.ok(
            isChildTreeAlive(bystander),
            "cleanup must leave a process outside this smoke untouched",
          );
          for (const event of eventsAt(root).filter((event) =>
            ["stopping", "exiting", "finalizing"].includes(event.event),
          )) {
            assert.equal(
              event.auth === true && event.models === true && event.artifacts,
              true,
              `${event.role} lost resources before ${event.event}`,
            );
          }
          if (scenario === "success") {
            assert.equal(code, 0, output);
            assert.ok(
              eventsAt(root).some((event) => event.event === "finalizing"),
              "terminal status must not cut off final runner writes",
            );
            assert.deepEqual(
              eventsAt(root)
                .filter((event) => event.event === "prompt")
                .map((event) => event.kind),
              [
                "intercom",
                "list",
                "foreground",
                "async",
                "parallel",
                "chain",
                "output",
                "acceptance",
              ],
            );
          } else {
            assert.notEqual(code, 0, "failure/cancellation must not report success");
            if (scenario === "timeout" || scenario === "startup-timeout") {
              assert.match(output, /timed out after 1000ms/);
            }
          }
        } finally {
          writeFileSync(join(root, "controller.private.log"), output, { mode: 0o600 });
          // RED deliberately leaks; the test still retires only its own fixtures before removing its files.
          const pids = new Set(
            eventsAt(root)
              .filter((event) => event.event === "started")
              .map((event) => event.pid),
          );
          for (const child of [controller, bystander]) {
            if ((child?.pid ?? 0) !== 0 && !Number.isNaN(child?.pid)) {
              assertDefined(child);
              assertDefined(child.pid);
              pids.add(child.pid);
            }
          }
          for (const pid of pids) {
            trySignalChildTree(processRef(pid), "SIGKILL");
          }
          await until(() => [...pids].every((pid) => !isChildTreeAlive(processRef(pid))));
          rmSync(auth, { recursive: true, force: true });
          if ((smokeRoot ?? "").length > 0) {
            for (const name of ["auth.json", "models.json"]) {
              assertDefined(smokeRoot);
              rmSync(join(smokeRoot, "pi-agent", name), { force: true });
            }
          }
          if (!((process.env.PI_REAL_SMOKE_TEST_ROOT ?? "").length > 0)) {
            rmSync(root, { recursive: true, force: true });
          }
        }
      });
    }
  },
);
