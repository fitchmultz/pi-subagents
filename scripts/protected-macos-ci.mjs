#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NativeController } from "./protected-macos-controller.mjs";
import { GuestBoundary } from "./protected-macos-guest-bootstrap.mjs";
import { inventory } from "./protected-macos-network.mjs";
import { operatorLock, saveState, writeReceipt } from "./protected-macos-operator.mjs";
import { qualify } from "./protected-macos-qualification.mjs";

const HELP = `Protected macOS per-job native adapter (not a scheduler or JIT owner).

Examples:
  node scripts/protected-macos-ci.mjs inventory > blocked.txt
  node scripts/protected-macos-ci.mjs qualify --state /private/operator/state.json
  node scripts/protected-macos-ci.mjs seal --state /private/operator/state.json
  node scripts/protected-macos-ci.mjs controller --state /private/operator/state.json

controller (alias run) stays attached to the official SDK owner's bounded private
NDJSON stream through actual listener return. The SDK owns JIT/registration and
REST/Git association; this adapter owns the clone, native guard, hook ACK and
native settlement. settle is the same attached recovery protocol, not a force
retire command. No manual/offline label replaces unattended PR/main/release CI.
qualify generates real keeper/native/absence receipts against the original cut.
seal checks that cut; it never admits surviving qualification work.
Unknown source/process/transport results retain the diagnostic disk and slot.
Exit0 protocol/operation completed, NOT a passing GitHub job;1 retained;2 usage.
See docs/code-quality.md for bootstrap, SDK activation and reviewed runner refresh.
`;
async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function seal(configuration, path) {
  const state = structuredClone(configuration);
  assert.equal(state.active, null);
  assert.equal(
    state.qualificationPhase,
    "completed",
    "Use qualify to generate evidence before sealing",
  );
  const receipt = JSON.parse(readFileSync(state.qualification, "utf8"));
  assert.equal(receipt.native.ownerOmitted, true);
  assert.equal(receipt.native.csrUnrestrictedDtraceResult, -1);
  assert.equal(receipt.native.csrErrno, 1);
  assert.equal(receipt.standaloneExit, 0);
  assert.equal(receipt.enclosedExit, 0);
  assert.equal(receipt.absence.allESRCH, true);
  assert.deepEqual(receipt.preQualificationCut, state.preQualificationCut);
  const guest = new GuestBoundary(state, state.bootstrap);
  await guest.connect();
  writeReceipt(state, "privilege", guest.security());
  assert.equal(
    guest.ci("test ! -e /Users/ci/runner/.credentials && test ! -e /Users/ci/runner/.runner"),
    "",
  );
  const quiet = await guest.settled();
  assert.deepEqual(
    [quiet.bootSeconds, quiet.bootMicroseconds],
    [receipt.preQualificationCut.bootSeconds, receipt.preQualificationCut.bootMicroseconds],
  );
  writeReceipt(state, "pre-seal-quiescence", quiet);
  guest.stop();
  const baseline = `${state.owner}-qualified-${randomUUID().slice(0, 8)}`;
  new GuestBoundary(state, baseline).clone(state.bootstrap);
  const baselineDiskHash = await fileDigest(join(state.tartHome, "vms", baseline, "disk.img"));
  const qualificationHash = createHash("sha256")
    .update(readFileSync(state.qualification))
    .digest("hex");
  saveState(path, { ...state, baseline, baselineDiskHash, qualificationHash });
  console.log(`Credential-free baseline sealed against original qualification cut: ${baseline}`);
}
async function* frames() {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      assert.ok(newline > 0 && newline <= 1048576, "Private protocol frame bound exceeded");
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      yield JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    }
    assert.ok(buffer.length <= 1048576, "Private protocol frame bound exceeded");
  }
  assert.equal(buffer.length, 0, "Truncated private protocol frame");
}
async function protocol(path) {
  const controller = new NativeController(path);
  const interrupted = () => {
    process.stdin.destroy(new Error("Operator interrupted; native lifetimes retained"));
  };
  process.on("SIGINT", interrupted);
  process.on("SIGHUP", interrupted);
  process.on("SIGTERM", interrupted);
  let failure;
  try {
    for await (const request of frames()) {
      let envelope;
      try {
        // for-await owns the required sequential protocol exchange.
        const result = await controller.exchange(request);
        envelope = {
          version: 1,
          id: request.id,
          operationID: request.operationID,
          ok: true,
          result,
        };
      } catch (error) {
        controller.failure(error);
        envelope = {
          version: 1,
          id: request.id,
          operationID: request.operationID,
          ok: false,
          result: { phase: "retained" },
          retained: true,
          error: {
            code: "E_NATIVE_RETAINED",
            message: "Native operation retained; inspect bounded private diagnostics",
          },
        };
      } finally {
        request.jitConfig = "";
      }
      if (!process.stdout.write(`${JSON.stringify(envelope)}\n`)) {
        // Protocol backpressure must drain before another reply is emitted.
        await once(process.stdout, "drain");
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await controller.close();
    } catch (error) {
      failure ??= error;
    }
    process.off("SIGINT", interrupted);
    process.off("SIGHUP", interrupted);
    process.off("SIGTERM", interrupted);
  }
  if (failure) {
    throw failure;
  }
}
function invocation() {
  const [command, flag, path] = process.argv.slice(2);
  if (["-h", "--help"].includes(command)) {
    console.log(HELP);
    return;
  }
  if (command === "inventory" && process.argv.length === 3) {
    console.log(inventory().blocked.trim());
    return;
  }
  if (
    !["qualify", "seal", "controller", "run", "settle"].includes(command) ||
    flag !== "--state" ||
    !path ||
    process.argv.length !== 5
  ) {
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  return { command, absolute: resolve(path) };
}
async function main() {
  const selected = invocation();
  if (!selected) {
    return;
  }
  const { command, absolute } = selected,
    admission = operatorLock(absolute, command);
  let failure;
  try {
    if (command === "qualify") {
      await qualify(
        admission.state,
        absolute,
        new GuestBoundary(admission.state, admission.state.bootstrap),
      );
    } else if (command === "seal") {
      await seal(admission.state, absolute);
    } else {
      await protocol(absolute);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      admission.release();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    throw failure;
  }
}
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Protected native operation failed");
  process.exitCode = 1;
}
