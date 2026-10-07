import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execute } from "./protected-macos-transport.mjs";

export const RUNNER_VERSION = "2.338.0";
export const WORKER_SHA256 = "86e9936dd13805d0a044db1ebd4da52fceae3ebdc7551bba75e5fc046caa00a2";
function gitObject(kind, bytes) {
  return createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
}
function treeHash(entries) {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)),
  );
  return gitObject(
    "tree",
    Buffer.concat(
      sorted.map((entry) =>
        Buffer.concat([
          Buffer.from(`${entry.mode} ${entry.name}\0`),
          Buffer.from(entry.sha, "hex"),
        ]),
      ),
    ),
  );
}
function filePath(file) {
  assert.ok(["100644", "100755", "120000"].includes(file.mode));
  assert.match(file.sha, /^[a-f0-9]{40}$/);
  assert.ok(
    typeof file.path === "string" &&
      Buffer.byteLength(file.path) < 4096 &&
      !file.path.includes("\\"),
  );
  // Git paths become descriptor-relative manifest fields; controls cannot enter framing.
  // oxlint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u007f]/u.test(file.path));
  const parts = file.path.split("/");
  assert.ok(parts.every((part) => part !== "" && ![".", "..", ".git"].includes(part)));
  return parts;
}
function freezeTree(files) {
  const directories = new Map([["", new Map()]]);
  for (const file of files) {
    const parts = filePath(file);
    let directory = "";
    for (const part of parts.slice(0, -1)) {
      const child = directory ? `${directory}/${part}` : part;
      const entries = directories.get(directory);
      assert.ok(
        !entries.has(part) || entries.get(part).directory === child,
        "File/directory collision",
      );
      entries.set(part, { name: part, sort: `${part}/`, mode: "40000", directory: child });
      if (!directories.has(child)) {
        directories.set(child, new Map());
      }
      directory = child;
    }
    const name = parts.at(-1),
      entries = directories.get(directory);
    assert.ok(!entries.has(name), "Duplicate source path");
    entries.set(name, { name, sort: name, mode: file.mode, sha: file.sha });
  }
  for (const [path, entries] of [...directories].reverse()) {
    const nodes = [...entries.values()];
    for (const node of nodes) {
      if (node.directory) {
        node.sha = directories.get(node.directory).sha;
      }
    }
    directories.get(path).sha = treeHash(nodes);
  }
  return directories.get("").sha;
}
export function freezeBinding(input, capture) {
  const binding = structuredClone(input);
  for (const key of [
    "operationID",
    "contextHash",
    "nonce",
    "runnerName",
    "runnerVersion",
    "workerSHA256",
  ]) {
    assert.equal(binding[key], capture[key], `Binding ${key} must match native capture`);
  }
  for (const [key, context] of Object.entries({
    repository: "repository",
    sha: "sha",
    ref: "ref",
    event: "eventName",
    runId: "runId",
    attempt: "attempt",
  })) {
    assert.equal(
      binding[key],
      capture.github[context],
      `Binding ${key} must match official context`,
    );
  }
  for (const key of ["requestId", "runnerId", "runId", "attempt", "jobId"]) {
    assert.ok(Number.isSafeInteger(binding[key]) && binding[key] > 0);
  }
  assert.ok(typeof binding.sdkJobId === "string" && binding.sdkJobId.length > 0);
  assert.equal(binding.commit, binding.sha);
  assert.match(binding.tree, /^[a-f0-9]{40}$/);
  assert.ok(
    Array.isArray(binding.files) && binding.files.length > 0 && binding.files.length <= 20000,
  );
  assert.equal(
    freezeTree(binding.files),
    binding.tree,
    "Full recursive file inventory must hash to immutable Git tree",
  );
  assert.ok(Buffer.byteLength(JSON.stringify(binding)) < 1048576);
  return binding;
}
export function guardedCapture(observation, active) {
  assert.equal(observation.guarded, true);
  assert.equal(observation.operationID, active.operationID);
  assert.equal(observation.nonce, active.nonce);
  assert.equal(observation.runnerName, active.runnerName);
  assert.equal(observation.runnerVersion, RUNNER_VERSION);
  assert.equal(observation.workerSHA256, WORKER_SHA256);
  const github = structuredClone(observation.github);
  assert.equal(github.repository, "fitchmultz/pi-subagents");
  assert.match(github.sha, /^[a-f0-9]{40}$/);
  assert.ok(
    typeof github.ref === "string" &&
      github.ref.startsWith("refs/") &&
      Buffer.byteLength(github.ref) <= 2048,
  );
  execute("/usr/bin/git", ["check-ref-format", github.ref], { env: { PATH: "/usr/bin:/bin" } });
  for (const key of ["runId", "attempt"]) {
    assert.match(github[key], /^[1-9][0-9]{0,15}$/);
    github[key] = Number(github[key]);
    assert.ok(Number.isSafeInteger(github[key]));
  }
  const { pid, uid, sid, birthSeconds, birthMicroseconds } = observation.hookIdentity;
  assert.equal(uid, 502);
  assert.ok(pid > 0 && sid > 0 && birthSeconds > 0);
  const capture = {
    operationID: active.operationID,
    nonce: active.nonce,
    runnerName: active.runnerName,
    github,
    hookIdentity: { pid, uid, sid, birthSeconds, birthMicroseconds },
    runnerVersion: RUNNER_VERSION,
    workerSHA256: WORKER_SHA256,
  };
  return {
    ...capture,
    contextHash: createHash("sha256").update(JSON.stringify(capture)).digest("hex"),
  };
}
export function terminalIdentity(terminal, active) {
  assert.equal(terminal.runnerId, active.runnerId);
  assert.equal(terminal.runnerName, active.runnerName);
  assert.ok(Number.isSafeInteger(terminal.runId) && terminal.runId > 0);
  assert.equal(terminal.registrationAbsent, true);
}
export function checkoutManifest(binding) {
  return binding.files.map((file) => `${file.mode}\t${file.sha}\t${file.path}\n`).join("");
}
