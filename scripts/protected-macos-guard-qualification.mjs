import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { darwinSnapshot } from "./compat-process-darwin.mjs";
import { RUNNER_VERSION, WORKER_SHA256 } from "./protected-macos-source.mjs";

async function control(guest, mode, value, observe) {
  const child = spawn(
    "/usr/bin/ssh",
    [
      ...guest.connectionArgs(),
      `/Users/ci/tools/node/bin/node /Users/ci/protected-macos-guard-probe.mjs ${mode} ${value}`,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    },
  );
  const lines = createInterface({ input: child.stdout });
  const publication = once(lines, "line");
  const outcome = once(child, "close");
  child.stdin.on("error", () => {
    /* Actual SSH return is joined below; no detached control. */
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(0, 65536);
  });
  let result, failure;
  try {
    const hostTransport = darwinSnapshot("", child.pid, Date.now() + 3000, true);
    assert.deepEqual(hostTransport.uncertainties, []);
    assert.equal(hostTransport.identities.length, 1);
    guest.recordTransport(`${mode}-${value}-before`, hostTransport);
    const first = await Promise.race([
      publication,
      outcome.then(() => {
        throw new Error(`Native control exited before publication: ${stderr}`);
      }),
    ]);
    const [line] = first;
    const ready = JSON.parse(line);
    assert.equal(ready.ready, true);
    ready.hostTransport = hostTransport.identities[0];
    assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
    result = await observe(ready);
  } catch (error) {
    failure = error;
  }
  try {
    child.stdin.end("release\n");
    const [code] = await outcome;
    lines.close();
    assert.equal(code, 0, `Owned native control failed; bounded diagnostics: ${stderr}`);
    guest.recordTransport(`${mode}-${value}-joined`, { code, actualChildWait: true });
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    throw failure;
  }
  return result;
}
function observation(guest, ready) {
  const sockets = guest.sockets(ready.pid);
  assert.equal(sockets.identity.uid, 502);
  assert.equal(sockets.identity.pid, ready.pid);
  assert.equal(sockets.uncertain, false);
  if (ready.mode === "--worker") {
    assert.equal(sockets.identity.path, "/Users/ci/runner/bin/Runner.Worker");
  }
  return { ...sockets, hostTransport: ready.hostTransport };
}
function tamper(guest, ready) {
  const before = observation(guest, ready);
  const probe = JSON.parse(guest.ci(`/Users/ci/protected-macos-tamper-probe ${ready.pid}`));
  const after = observation(guest, ready);
  for (const key of ["pid", "uid", "sid", "birthSeconds", "birthMicroseconds"]) {
    assert.equal(after.identity[key], before.identity[key]);
  }
  assert.equal(probe.uid, 502);
  assert.equal(probe.pid, ready.pid);
  return { before, probe, after };
}
export async function qualifyGuard(guest, state) {
  const reviewedInputs = JSON.parse(
    guest.root("/Library/ProtectedCI/quiescence --job-reviewed-inputs"),
  );
  assert.equal(reviewedInputs.reviewedInputs, true);
  for (const name of ["protected-macos-guard-probe.mjs", "protected-macos-tamper-probe.c"]) {
    guest.uploadCI(name, readFileSync(new URL(name, import.meta.url), "utf8"));
  }
  guest.ci(
    "/usr/bin/clang -Wall -Werror /Users/ci/protected-macos-tamper-probe.c -o /Users/ci/protected-macos-tamper-probe",
  );
  const diagnosticsEnabled = await control(guest, "--worker", "1", (ready) =>
    observation(guest, ready),
  );
  assert.equal(diagnosticsEnabled.noListeners, false);
  assert.equal(
    diagnosticsEnabled.listeningSocket.family,
    1,
    "Genuine Worker diagnostic Unix listener required",
  );
  const diagnosticsDisabled = await control(guest, "--worker", "0", (ready) =>
    tamper(guest, ready),
  );
  const tcp = await control(guest, "--socket", "tcp", (ready) => observation(guest, ready));
  const unix = await control(guest, "--socket", "unix", (ready) => observation(guest, ready));
  const receipt = {
    runnerVersion: RUNNER_VERSION,
    workerSHA256: WORKER_SHA256,
    reviewedInputs,
    diagnosticsEnabled,
    diagnosticsDisabled,
    tcp,
    unix,
    actualJobCertified: false,
  };
  // Save actual native results BEFORE assertions: a failed premise remains diagnostic evidence.
  writeFileSync(
    join(state.root, `${state.active?.name ?? state.bootstrap}.prejob-guard-proof.json`),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  );
  assert.equal(diagnosticsDisabled.before.noListeners, true);
  assert.equal(diagnosticsDisabled.after.noListeners, true);
  assert.equal(
    diagnosticsDisabled.probe.taskPortGranted,
    false,
    "CI UID obtained official Worker task port; guard premise FAILED",
  );
  assert.equal(
    diagnosticsDisabled.probe.ptraceResult,
    -1,
    "CI UID attached official Worker; guard premise FAILED",
  );
  assert.equal(
    diagnosticsDisabled.probe.ptraceErrno,
    1,
    "Actual EPERM denial required, not missing/busy Worker inference",
  );
  assert.equal(tcp.noListeners, false);
  assert.equal(tcp.listeningSocket.family, 2);
  assert.equal(tcp.listeningSocket.tcpState, 1);
  assert.equal(unix.noListeners, false);
  assert.equal(unix.listeningSocket.family, 1);
  return {
    ...receipt,
    diagnosticsDisabledProved: true,
    tamperDenied: true,
    nativeSocketControls: true,
  };
}
