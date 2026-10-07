import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { darwinSnapshot } from "../../scripts/compat-process-darwin.mjs";
import { destinationInventory } from "../../scripts/protected-macos-network.mjs";
import { NativeController } from "../../scripts/protected-macos-controller.mjs";
import { freezeBinding } from "../../scripts/protected-macos-source.mjs";
import { execute, observeReadiness } from "../../scripts/protected-macos-transport.mjs";

const operator = new URL("../../scripts/protected-macos-operator.mjs", import.meta.url).href;
const cli = fileURLToPath(new URL("../../scripts/protected-macos-ci.mjs", import.meta.url));
const publicationFixture = fileURLToPath(new URL("./fixtures/protected-file.c", import.meta.url));
const idleFixture = fileURLToPath(
  new URL("../fixtures/protected-idle-process.mjs", import.meta.url),
);
const lifecycleFixture = fileURLToPath(
  new URL("./fixtures/protected-lifecycle.c", import.meta.url),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "protected-macos-owner-"));
  const state = {
    version: 1,
    owner: "protected-a1b2c3d4",
    root,
    bootstrap: "protected-a1b2c3d4-bootstrap",
    baseline: "protected-a1b2c3d4-qualified",
    gateway: "192.168.64.1",
    active: null,
  };
  for (const key of ["tart", "key", "knownHosts", "private", "qualification"]) {
    state[key] = join(root, key);
    writeFileSync(state[key], "{}", { mode: 0o600 });
  }
  state.tartHome = join(root, "tart-home");
  mkdirSync(state.tartHome, { mode: 0o700 });
  const path = join(root, "state.json");
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  return { root, path };
}
function contender(path, command = "settle") {
  const program = `import {operatorLock,saveState} from ${JSON.stringify(operator)};
    process.stdin.once('data',()=>{
      try {
        const owner=operatorLock(${JSON.stringify(path)},${JSON.stringify(command)});
        console.log(JSON.stringify({admitted:true,pid:process.pid,state:owner.state}));
        process.stdin.once('data',(input)=>{
          if(input.toString().trim()==='retain'){saveState(${JSON.stringify(path)},{...owner.state,active:{phase:'retained-test-intent'}});process.exit(0);}
          owner.release();process.exit(0);
        });
      } catch(error) {console.log(JSON.stringify({admitted:false,message:error.message}));process.exit(0);}
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {
    // Teardown may close an already-exited contender; its actual exit is joined.
  });
  const lines = createInterface({ input: child.stdout });
  const publication = once(lines, "line").then(([line]) => JSON.parse(line));
  const exit = once(child, "exit");
  return { child, publication, exit, lines };
}
function idleOperation(options = {}, contradiction = {}) {
  const owned = fixture();
  const state = JSON.parse(readFileSync(owned.path, "utf8"));
  const operationID = "00000000-0000-0000-0000-000000000001";
  const cut = { uid: 502, bootSeconds: 1000, bootMicroseconds: 7, identities: [] };
  state.active = {
    operationID,
    name: `${state.owner}-job-${operationID}`,
    runnerName: "idle-fixture",
    phase: "prepared",
    prepared: true,
    cut,
    ...contradiction,
  };
  writeFileSync(owned.path, JSON.stringify(state), { mode: 0o600 });
  writeFileSync(join(owned.root, "idle-fixture.json"), JSON.stringify({ cut, ...options }), {
    mode: 0o600,
  });
  return { ...owned, operationID };
}
function protocolOwner(owned) {
  const child = spawn(
    process.execPath,
    ["--import", idleFixture, cli, "controller", "--state", owned.path],
    {
      env: { ...process.env, PROTECTED_IDLE_TEST_ROOT: owned.root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk.toString();
  });
  child.stdin.on("error", () => {
    // EOF teardown may encounter a closed stdin; actual child close is always joined.
  });
  const lines = createInterface({ input: child.stdout });
  const exit = once(child, "close");
  let id = 0;
  return {
    child,
    lines,
    exit,
    diagnostic: () => diagnostic,
    async request(action, fields = {}) {
      const publication = once(lines, "line");
      child.stdin.write(
        JSON.stringify({
          version: 1,
          id: ++id,
          operationID: owned.operationID,
          action,
          ...fields,
        }) + "\n",
      );
      const [line] = await publication;
      return JSON.parse(line);
    },
  };
}
function fixtureControl(owned, endpoint, command = "release") {
  const result = spawnSync(
    process.execPath,
    [idleFixture, "control", owned.root, endpoint, command],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
}
function operations(owned) {
  const path = join(owned.root, "operations.ndjson");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).operation)
    : [];
}
function configureIdle(owned, patch) {
  const path = join(owned.root, "idle-fixture.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }), {
    mode: 0o600,
  });
}
async function revokeDisposal(owned, owner, original) {
  configureIdle(owned, { changedCut: true });
  const refused = await owner.request("status");
  assert.equal(refused.ok, false);
  assert.equal(refused.retained, true);
  const active = JSON.parse(readFileSync(owned.path, "utf8")).active;
  assert.equal(active.interruptedUnassigned, false);
  assert.equal(active.phase, "idle-interrupting");
  assert.deepEqual(active.disposalProof, original.disposalProof);
  assert.deepEqual(active.idleStopProof, original.idleStopProof);
  return {
    phase: active.phase,
    interruptedUnassigned: active.interruptedUnassigned,
  };
}
async function launchIdle(owner) {
  const reply = await owner.request("launch", {
    runnerID: 77,
    runnerName: "idle-fixture",
    scaleSetId: 1,
    repository: "fitchmultz/pi-subagents",
    jitConfig: "LOCAL_PROCESS_FIXTURE_NOT_A_JIT_CREDENTIAL",
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
}
async function releaseIdle(owned, owner) {
  if (existsSync(join(owned.root, "t"))) {
    fixtureControl(owned, "t");
  }
  if (existsSync(join(owned.root, "c"))) {
    fixtureControl(owned, "c");
  }
  owner.child.stdin.end();
  await owner.exit;
  owner.lines.close();
}
async function start(candidate) {
  candidate.child.stdin.write("go\n");
  return await candidate.publication;
}
async function publicationCompletion(binary, path, mode) {
  const child = spawn(binary, [path, "durable fixture data\n", mode], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {
    // Actual child close is joined even when an injected failure already returned.
  });
  const lines = createInterface({ input: child.stdout });
  const exited = once(child, "close");
  try {
    const [line] = await once(lines, "line");
    const phase = JSON.parse(line);
    assert.equal(phase.phase, "before-directory-fsync");
    assert.equal(phase.completed, 0);
    assert.equal(readFileSync(path, "utf8"), "durable fixture data\n");
    assert.equal(statSync(path).mode & 0o777, 0o444);
    assert.equal(statSync(path).nlink, 1);
    const ack = mode.startsWith("ack-");
    assert.equal(phase.directories, ack ? 2 : 1);
    if (ack) {
      assert.equal(readFileSync(`${path}.marker`, "utf8"), "ack-marker\n");
      assert.equal(statSync(`${path}.marker`).nlink, 1);
    }
    const completed = once(lines, "line");
    child.stdin.end("go\n");
    const [result] = await completed;
    const publication = JSON.parse(result);
    const failed = mode.endsWith("fail");
    assert.equal(publication.result, failed ? 2 : 0);
    assert.equal(publication.completed, failed ? 0 : 1);
    assert.equal(publication.replay, failed ? 2 : 1);
    if (failed) {
      assert.equal(publication.errno, constants.errno.EIO);
    }
    assert.deepEqual(await exited, [0, null]);
  } finally {
    child.stdin.end("go\n");
    await exited;
    lines.close();
  }
}

// Real flock + stale-process recovery, not a mocked lock or a supplied success receipt.
test(
  "kernel-exclusive recovery admits one contender and preserves its live owner/current journal",
  { timeout: 15000 },
  async () => {
    const owned = fixture();
    const candidates = [];
    try {
      const first = contender(owned.path);
      candidates.push(first);
      assert.equal((await start(first)).admitted, true);
      const inode = statSync(join(owned.root, "operator.guard")).ino;
      const busy = contender(owned.path);
      candidates.push(busy);
      assert.equal((await start(busy)).admitted, false);
      await busy.exit;
      first.child.stdin.write("retain\n");
      await first.exit;
      assert.throws(() => process.kill(first.child.pid, 0), { code: "ESRCH" });
      const a = contender(owned.path),
        b = contender(owned.path);
      candidates.push(a, b);
      const reports = await Promise.all([start(a), start(b)]);
      assert.equal(reports.filter((report) => report.admitted).length, 1);
      const index = reports.findIndex((report) => report.admitted),
        winner = candidates[index + 2];
      const loser = index === 0 ? b : a;
      await loser.exit;
      assert.equal(reports[index].state.active.phase, "retained-test-intent");
      assert.equal(
        JSON.parse(readFileSync(join(owned.root, "operator.owner.json"))).pid,
        winner.child.pid,
      );
      assert.equal(statSync(join(owned.root, "operator.guard")).ino, inode);
      winner.child.stdin.write("release\n");
      await winner.exit;
      assert.equal(statSync(join(owned.root, "operator.guard")).ino, inode);
    } finally {
      for (const candidate of candidates) {
        candidate.child.stdin.end("release\n");
        candidate.lines.close();
      }
      await Promise.all(candidates.map((candidate) => candidate.exit));
      rmSync(owned.root, { recursive: true, force: true });
    }
  },
);

test("BSD route inventory covers abbreviated globally addressed subnets, hosts and point-to-point peers", () => {
  const snapshot = {
    publicIP: "203.0.113.10",
    interfaces:
      "utun0: flags=8051\n\tinet 17.2.3.4 --> 17.2.3.5 netmask 0xffffffff\nen0: flags=8863\n\tinet 198.51.100.6 netmask 0xffffff00 broadcast 198.51.100.255\n",
    routes:
      "Routing tables\n\nInternet:\nDestination Gateway Flags Netif Expire\ndefault 192.168.64.1 UGScg en0\ndefault link#4 UCSIg utun0\n10.37.129/24 link#3 UCS en0\n17/8 link#4 UCS utun0\n100.64/10 link#3 UCS en0\n192.168.1 link#3 UCS en0\n198.51.100.8 link#3 UHLWI en0\n",
  };
  const blocked = new Set(destinationInventory(snapshot).blocked.trim().split("\n"));
  for (const expected of [
    "10.37.129.0/24",
    "17.0.0.0/8",
    "100.64.0.0/10",
    "192.168.1.0/24",
    "198.51.100.8/32",
    "17.2.3.4/32",
    "17.2.3.5/32",
    "198.51.100.0/24",
    "192.168.64.1/32",
    "203.0.113.10/32",
  ]) {
    assert.ok(blocked.has(expected), expected);
  }
  assert.throws(
    () =>
      destinationInventory({
        ...snapshot,
        routes: snapshot.routes + "default link#9 UCSIg missingInterface\n",
      }),
    /Unresolved scoped default/,
  );
  assert.throws(() =>
    destinationInventory({
      ...snapshot,
      routes: snapshot.routes + "17.8/not-a-prefix link#4 UCS utun0\n",
    }),
  );
  assert.throws(
    () => destinationInventory({ ...snapshot, interfaces: "\tinet 17.2.3.4 netmask 0xff00ff00\n" }),
    /Noncontiguous/,
  );
});

test("transport preserves native spawn/timeout causes and bounds diagnostics after secret redaction", () => {
  assert.throws(() => execute("/nonexistent/protected-macos-test", []), { code: "ENOENT" });
  assert.throws(
    () => execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 200 }),
    { code: "ETIMEDOUT" },
  );
  const secret = "FAKE_SECRET_BOUNDARY_VALUE";
  assert.throws(
    () =>
      execute(
        process.execPath,
        [
          "-e",
          "process.stderr.write('x'.repeat(65530)+process.env.FIXTURE_SECRET+'y'.repeat(100));process.exitCode=7",
        ],
        { env: { FIXTURE_SECRET: secret }, secrets: [secret] },
      ),
    (error) => {
      assert.equal(error.diagnostic.status, 7);
      assert.equal(error.diagnostic.stderr.length, 65536);
      assert.ok(!error.diagnostic.stderr.includes("FAKE_S"));
      return true;
    },
  );
});

test("source binding recreates an actual immutable Git tree and rejects incomplete/replayed inventories", () => {
  const root = mkdtempSync(join(tmpdir(), "protected-macos-git-"));
  try {
    execute("git", ["init", "-q", root]);
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "a"), "one\n");
    writeFileSync(join(root, "dir", "b"), "two\n");
    execute("git", ["-C", root, "add", "."]);
    const tree = execute("git", ["-C", root, "write-tree"]).trim();
    const files = execute("git", ["-C", root, "ls-tree", "-r", tree])
      .trim()
      .split("\n")
      .map((line) => {
        const [metadata, path] = line.split("\t"),
          [mode, , sha] = metadata.split(" ");
        return { path, mode, sha };
      });
    const capture = {
      operationID: "00000000-0000-0000-0000-000000000001",
      contextHash: "1".repeat(64),
      nonce: "2".repeat(64),
      runnerName: "official-test",
      runnerVersion: "2.338.0",
      workerSHA256: "86e9936dd13805d0a044db1ebd4da52fceae3ebdc7551bba75e5fc046caa00a2",
      github: {
        repository: "fitchmultz/pi-subagents",
        sha: "3".repeat(40),
        ref: "refs/heads/main",
        eventName: "push",
        runId: 123,
        attempt: 1,
      },
    };
    const binding = {
      ...capture,
      repository: capture.github.repository,
      sha: capture.github.sha,
      commit: capture.github.sha,
      ref: capture.github.ref,
      event: "push",
      runId: 123,
      attempt: 1,
      requestId: 9,
      runnerId: 10,
      jobId: 11,
      sdkJobId: "opaque-server-job",
      tree,
      files,
    };
    assert.equal(freezeBinding(binding, capture).tree, tree);
    assert.throws(
      () => freezeBinding({ ...binding, files: files.slice(1) }, capture),
      /immutable Git tree/,
    );
    assert.throws(
      () => freezeBinding({ ...binding, files: [...files, files[0]] }, capture),
      /Duplicate/,
    );
    assert.throws(
      () => freezeBinding({ ...binding, nonce: "4".repeat(64) }, capture),
      /native capture/,
    );
    assert.throws(() =>
      freezeBinding({ ...binding, files: [{ ...files[0], path: "dir/.git/config" }] }, capture),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "attached protocol bounds framing and rejects premature binding/launch without inventing a guest",
  { timeout: 10000 },
  () => {
    const owned = fixture();
    try {
      const operationID = "00000000-0000-0000-0000-000000000001";
      const input =
        [
          { version: 1, id: 1, operationID, action: "status" },
          { version: 1, id: 2, operationID, action: "bind", binding: {} },
          {
            version: 1,
            id: 3,
            operationID,
            action: "launch",
            jitConfig: "FAKE_TEST_JIT_NOT_A_CREDENTIAL",
          },
        ]
          .map((request) => JSON.stringify(request))
          .join("\n") + "\n";
      const result = spawnSync(process.execPath, [cli, "controller", "--state", owned.path], {
        input,
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      const replies = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        replies.map((reply) => [reply.id, reply.operationID, reply.ok]),
        [
          [1, operationID, true],
          [2, operationID, false],
          [3, operationID, false],
        ],
      );
      assert.equal(replies[0].result.phase, "absent");
      assert.equal(replies[2].retained, true);
      assert.ok(!result.stdout.includes("FAKE_TEST_JIT"));
      assert.equal(JSON.parse(readFileSync(owned.path)).active, null);
      for (const [frame, diagnostic] of [
        ['{"version":1', "Truncated private protocol frame"],
        [`{"padding":"${"x".repeat(1048576)}"}\n`, "Private protocol frame bound exceeded"],
      ]) {
        const invalid = spawnSync(process.execPath, [cli, "controller", "--state", owned.path], {
          input: frame,
          encoding: "utf8",
          timeout: 5000,
        });
        assert.equal(invalid.error, undefined);
        assert.equal(invalid.status, 1);
        assert.ok(invalid.stderr.includes(diagnostic), invalid.stderr);
        assert.equal(JSON.parse(readFileSync(owned.path)).active, null);
      }
    } finally {
      rmSync(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "protected publication exposes complete read-only bytes, never replaces replay, and leaves no failed final",
  { timeout: 15000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "protected-file-")));
    try {
      const binary = join(root, "publication");
      execute("cc", ["-Wall", "-Werror", publicationFixture, "-o", binary]);
      const path = join(root, "complete");
      const publish = (target, value, mode = "normal") =>
        JSON.parse(execute(binary, [target, value, mode]));
      assert.equal(publish(path, "complete configuration\n").result, 0);
      assert.equal(readFileSync(path, "utf8"), "complete configuration\n");
      assert.equal(statSync(path).mode & 0o777, 0o444);
      const inode = statSync(path).ino;
      assert.equal(publish(path, "replacement\n").result, 1);
      assert.equal(readFileSync(path, "utf8"), "complete configuration\n");
      assert.equal(statSync(path).ino, inode);
      const failed = join(root, "failed");
      const failure = publish(failed, "incomplete configuration\n", "short-write");
      assert.equal(failure.result, 2);
      assert.equal(existsSync(failed), false);
      assert.equal(failure.errno, constants.errno.EFBIG);
      assert.deepEqual(readdirSync(root).sort(), ["complete", "publication"]);
      const record = join(root, "record");
      assert.equal(publish(record, "", "binary").result, 0);
      assert.deepEqual(readFileSync(record), Buffer.from([0, 1, 255, 0, 42, 10]));
      assert.equal(statSync(record).mode & 0o777, 0o444);
      for (const mode of ["commit", "commit-fail", "ack-success", "ack-fail"]) {
        // Each actual publisher blocks at its observed final directory-fsync boundary.
        // oxlint-disable-next-line no-await-in-loop
        await t.test(mode, () => publicationCompletion(binary, join(root, mode), mode));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "local synthetic lifecycle rejects missing prefix, replacements, gaps, backpressure and foreign ACK execution",
  { skip: process.platform !== "darwin" },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "protected-lifecycle-")));
    try {
      const binary = join(root, "lifecycle");
      const sdk = execute("/usr/bin/xcrun", ["--show-sdk-path"]).trim();
      execute("/usr/bin/clang", [
        "-Wall",
        "-Werror",
        "-Wno-deprecated-declarations",
        "-fblocks",
        "-mmacosx-version-min=13.0",
        "-isysroot",
        sdk,
        lifecycleFixture,
        "-lEndpointSecurity",
        "-lbsm",
        "-framework",
        "Security",
        "-framework",
        "CoreFoundation",
        "-o",
        binary,
      ]);
      const result = JSON.parse(execute(binary, []));
      assert.equal(
        result.scope,
        "local synthetic state, callback, publication queue, ACK and terminal predicates only",
      );
      assert.equal(result.cases, 14);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("attached controller retries failed guest IP lookup without caching an unconnected boundary", async () => {
  const owned = fixture();
  let controller;
  try {
    const state = JSON.parse(readFileSync(owned.path, "utf8"));
    const operationID = "00000000-0000-0000-0000-000000000001";
    state.active = { operationID, name: `${state.owner}-job-${operationID}`, jitSent: true };
    writeFileSync(owned.path, JSON.stringify(state), { mode: 0o600 });
    const attempts = join(owned.root, "ip-attempts");
    writeFileSync(
      state.tart,
      `#!${process.execPath}
import {appendFileSync} from "node:fs";
appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(process.argv.slice(2))+"\\n");
process.exitCode=7;
`,
      { mode: 0o700 },
    );
    chmodSync(state.tart, 0o700);
    controller = new NativeController(owned.path);
    const capture = (id) => controller.exchange({ version: 1, id, operationID, action: "capture" });
    const originalFailure = (error) => {
      assert.equal(error.diagnostic?.status, 7);
      assert.ok(error.message.includes("failed (exit 7)"));
      return true;
    };
    await assert.rejects(capture(1), originalFailure);
    await assert.rejects(capture(2), originalFailure);
    const lookups = readFileSync(attempts, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lookups, [
      ["ip", state.active.name, "--wait", "120"],
      ["ip", state.active.name, "--wait", "120"],
    ]);
    assert.equal(JSON.parse(readFileSync(owned.path, "utf8")).active.name, state.active.name);
  } finally {
    if (controller) {
      await assert.rejects(controller.close(), /failed \(exit 7\)/);
    }
    rmSync(owned.root, { recursive: true, force: true });
  }
});

// Guest operations are controlled public-boundary mocks, NOT native guard/cut qualification.
// CLI admission, journal writes, transport/consumer lifetimes and kernel identities are real.
// This Mac owner requires actual Darwin libproc identities; Linux cannot exercise that boundary.
test(
  "idle EOF joins the same transport consumers before releasing its guard, then recovers and replays distinctly",
  { timeout: 30000, skip: process.platform !== "darwin" },
  async (t) => {
    const owned = idleOperation();
    const owners = [];
    try {
      const owner = protocolOwner(owned);
      owners.push(owner);
      await launchIdle(owner);
      owner.child.stdin.end();
      await observeReadiness(
        () => existsSync(join(owned.root, "transport-exited.json")),
        "actual transport exit",
        5000,
      );
      const waiting = JSON.parse(readFileSync(owned.path, "utf8")).active;
      assert.equal(waiting.operatorEOF, true);
      assert.equal(waiting.phase, "idle-interrupting");
      assert.equal(waiting.idleStopProof.drain.stoppedIdleListener, true);
      assert.notEqual(waiting.interruptedUnassigned, true);
      assert.notEqual(waiting.transportEnded, true);
      const consumer = JSON.parse(readFileSync(join(owned.root, "consumer-ready.json"), "utf8"));
      t.diagnostic(
        JSON.stringify({
          scope: "controlled host orchestration, NOT guest qualification",
          protocolPID: owner.child.pid,
          transport: waiting.transportIdentity,
          consumer,
        }),
      );
      assert.doesNotThrow(() => process.kill(consumer.pid, 0));
      const blocked = contender(owned.path);
      assert.equal((await start(blocked)).admitted, false);
      await blocked.exit;
      blocked.lines.close();
      assert.ok(!operations(owned).includes("original-cut"));
      fixtureControl(owned, "c");
      assert.deepEqual(await owner.exit, [0, null], owner.diagnostic());
      const recovered = JSON.parse(readFileSync(owned.path, "utf8")).active;
      assert.equal(recovered.phase, "idle-interrupted");
      assert.equal(recovered.interruptedUnassigned, true);
      assert.equal(recovered.transportEnded, true);
      assert.equal(recovered.idleInterruptionProof.listenerAbsent.listenerAbsent, true);
      assert.ok(!operations(owned).includes("stop"));
      assert.ok(!operations(owned).includes("delete"));
      assert.throws(() => process.kill(consumer.pid, 0), { code: "ESRCH" });
      const saved = JSON.parse(readFileSync(owned.path, "utf8"));
      for (const fault of ["missing-stop", "changed-stop"]) {
        const altered = structuredClone(saved);
        if (fault === "missing-stop") {
          delete altered.active.idleStopProof;
        } else {
          altered.active.idleStopProof.identity.runnerId = 78;
        }
        writeFileSync(owned.path, JSON.stringify(altered), { mode: 0o600 });
        const broken = protocolOwner(owned);
        owners.push(broken);
        // Each restarted owner holds the same guard until its actual EOF/error return.
        // oxlint-disable-next-line no-await-in-loop
        const refused = await broken.request("status");
        assert.equal(refused.ok, false);
        assert.equal(refused.retained, true);
        broken.child.stdin.end();
        // Join this rejected owner before the next fault replaces its shared journal.
        // oxlint-disable-next-line no-await-in-loop
        assert.equal((await broken.exit)[0], 1);
        assert.equal(operations(owned).filter((operation) => operation === "idle-drain").length, 1);
      }
      writeFileSync(owned.path, JSON.stringify(saved), { mode: 0o600 });
      const replacement = protocolOwner(owned);
      owners.push(replacement);
      const status = await replacement.request("status");
      assert.equal(status.ok, true);
      assert.equal(status.result.interruptedUnassigned, true);
      assert.equal(status.result.transportEnded, true);
      assert.equal((await replacement.request("capture")).result.interruptedUnassigned, true);
      const config = JSON.parse(readFileSync(join(owned.root, "idle-fixture.json"), "utf8"));
      writeFileSync(
        join(owned.root, "idle-fixture.json"),
        JSON.stringify({ ...config, changedCut: true }),
      );
      const uncertain = await replacement.request("status");
      assert.equal(uncertain.ok, false);
      assert.equal(uncertain.retained, true);
      assert.notEqual(
        JSON.parse(readFileSync(owned.path, "utf8")).active.interruptedUnassigned,
        true,
      );
      writeFileSync(join(owned.root, "idle-fixture.json"), JSON.stringify(config));
      const restored = await replacement.request("status");
      assert.equal(restored.ok, true, JSON.stringify(restored));
      assert.equal(restored.result.interruptedUnassigned, true);
      assert.equal(restored.result.phase, "idle-interrupted");
      assert.equal(operations(owned).filter((operation) => operation === "idle-drain").length, 1);
      const terminal = {
        interruptedUnassigned: true,
        noJob: true,
        runnerId: 77,
        runnerName: "idle-fixture",
        registrationAbsent: true,
        runId: 0,
        attempt: 0,
        jobId: 0,
        conclusion: "",
      };
      const before = operations(owned).length;
      for (const changed of [
        { runnerId: 78 },
        { runnerName: "foreign" },
        { registrationAbsent: false },
        { noJob: false },
        { requestId: 1 },
        { runId: 1 },
        { attempt: 1 },
        { jobId: 1 },
        { conclusion: "success" },
        { canceled: true },
        { vetoed: true },
      ]) {
        // One attached owner processes each negative before the next terminal is sent.
        // oxlint-disable-next-line no-await-in-loop
        const invalid = await replacement.request("settle", {
          terminal: { ...terminal, ...changed },
        });
        assert.equal(invalid.ok, false);
        assert.equal(invalid.retained, true);
        assert.equal(operations(owned).length, before);
      }
      const disposed = await replacement.request("settle", { terminal });
      assert.equal(disposed.ok, true, JSON.stringify(disposed));
      assert.equal(disposed.result.disposed, true);
      assert.equal(disposed.result.interruptedUnassigned, true);
      assert.equal(disposed.result.transportEnded, true);
      assert.equal(disposed.result.sourceVerified, false);
      assert.equal(disposed.result.vetoVerified, false);
      const replayed = {
        ...disposed.result,
        operationID: owned.operationID,
        runnerName: "idle-fixture",
      };
      assert.deepEqual((await replacement.request("settle", { terminal })).result, replayed);
      assert.equal(
        (await replacement.request("settle", { terminal: { ...terminal, canceled: true } })).ok,
        false,
      );
      replacement.child.stdin.end();
      assert.deepEqual(await replacement.exit, [0, null], replacement.diagnostic());
      const replay = protocolOwner(owned);
      owners.push(replay);
      assert.deepEqual((await replay.request("settle", { terminal })).result, replayed);
      replay.child.stdin.end();
      assert.deepEqual(await replay.exit, [0, null], replay.diagnostic());
    } finally {
      await Promise.all(owners.map((owner) => releaseIdle(owned, owner)));
      rmSync(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "idle EOF retains busy, vetoed, absent-first and changed-cut operations without inventing a no-job proof",
  { timeout: 30000, skip: process.platform !== "darwin" },
  async () => {
    for (const scenario of [
      { contradiction: { capture: { retainedContext: true } } },
      { contradiction: { binding: { retainedSource: true } } },
      { contradiction: { acked: true } },
      { contradiction: { veto: { code: "integrity" } } },
      { contradiction: { completion: { jobId: "known-completed" } } },
      { contradiction: { assignment: { requestId: 9 } } },
      { options: { rootVeto: true }, exit: 1 },
      { options: { firstAbsent: true }, exit: 1 },
      { options: { changedCut: true }, exit: 1 },
    ]) {
      const owned = idleOperation(scenario.options, scenario.contradiction);
      const owner = protocolOwner(owned);
      try {
        // These rows share no resources but execute serially for readable lifetime evidence.
        // oxlint-disable-next-line no-await-in-loop
        await launchIdle(owner);
        owner.child.stdin.end();
        // Observe actual durable EOF processing, not a sleep-based negative assertion.
        // oxlint-disable-next-line no-await-in-loop
        await observeReadiness(
          () => JSON.parse(readFileSync(owned.path, "utf8")).active.operatorEOF === true,
          "durable EOF",
          5000,
        );
        if (scenario.options) {
          // Observe the actual root-probe boundary before releasing controlled resources.
          // oxlint-disable-next-line no-await-in-loop
          await observeReadiness(
            () => operations(owned).includes("idle-drain"),
            "observed root probe",
            5000,
          );
        }
        if (scenario.options?.changedCut) {
          // The cut mismatch must be reached after the owner's actual controlled idle stop.
          // oxlint-disable-next-line no-await-in-loop
          await observeReadiness(
            () => existsSync(join(owned.root, "transport-exited.json")),
            "controlled idle stop",
            5000,
          );
        }
        // Join this scenario's transport before reading its final persisted state.
        // oxlint-disable-next-line no-await-in-loop
        await releaseIdle(owned, owner);
        // Consume this owner's actual exit before advancing to the next scenario.
        // oxlint-disable-next-line no-await-in-loop
        assert.equal((await owner.exit)[0], scenario.exit ?? 0, owner.diagnostic());
        const active = JSON.parse(readFileSync(owned.path, "utf8")).active;
        assert.notEqual(active.interruptedUnassigned, true);
        assert.equal(active.windowClosed, true);
        if (scenario.options?.changedCut) {
          assert.equal(active.idleStopProof.drain.stoppedIdleListener, true);
        }
        assert.ok(!operations(owned).includes("stop"));
        assert.ok(!operations(owned).includes("delete"));
        if (scenario.contradiction) {
          assert.ok(!operations(owned).includes("idle-drain"));
        }
      } finally {
        // The owner must return before its private fixture root can be removed.
        // oxlint-disable-next-line no-await-in-loop
        await releaseIdle(owned, owner);
        rmSync(owned.root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "interrupted disposal resumes stopped/absent checkpoints and reobserves running retries",
  { timeout: 30000, skip: process.platform !== "darwin" },
  async (t) => {
    for (const { method: checkpoint, inventory, phase } of [
      { method: "stop", inventory: "stopped", phase: "stopping" },
      { method: "delete", inventory: "absent", phase: "deleting" },
      { method: "before-stop", inventory: "running", phase: "stopping" },
    ]) {
      // Each checkpoint owns a distinct actual CLI/journal/transport lifetime.
      // oxlint-disable-next-line no-await-in-loop
      await t.test(checkpoint, async () => {
        const owned = idleOperation({ exitAfter: checkpoint });
        const owners = [];
        try {
          const initial = protocolOwner(owned);
          owners.push(initial);
          await launchIdle(initial);
          initial.child.stdin.end();
          await observeReadiness(
            () => existsSync(join(owned.root, "transport-exited.json")),
            "actual idle transport exit",
            5000,
          );
          fixtureControl(owned, "c");
          assert.deepEqual(await initial.exit, [0, null], initial.diagnostic());
          const terminal = {
            interruptedUnassigned: true,
            noJob: true,
            runnerId: 77,
            runnerName: "idle-fixture",
            registrationAbsent: true,
          };
          const interrupted = protocolOwner(owned);
          owners.push(interrupted);
          interrupted.child.stdin.write(
            JSON.stringify({
              version: 1,
              id: 1,
              operationID: owned.operationID,
              action: "settle",
              terminal,
            }) + "\n",
          );
          await observeReadiness(
            () => existsSync(join(owned.root, "disposal-checkpoint.json")),
            `actual ${checkpoint} pre-tombstone checkpoint`,
            5000,
          );
          assert.deepEqual(await interrupted.exit, [23, null], interrupted.diagnostic());
          const published = JSON.parse(
            readFileSync(join(owned.root, "disposal-checkpoint.json"), "utf8"),
          );
          assert.equal(published.owner.pid, interrupted.child.pid);
          assert.equal(published.inventory, inventory);
          const ended = darwinSnapshot("", published.owner.pid, Date.now() + 3000, true);
          assert.deepEqual(ended.identities, []);
          assert.deepEqual(ended.uncertainties, []);
          const saved = JSON.parse(readFileSync(owned.path, "utf8"));
          assert.equal(saved.active.phase, phase);
          assert.equal(saved.active.disposalProof.interruptedUnassigned, true);
          assert.equal(saved.active.disposalProof.sourceVerified, false);
          assert.equal(saved.active.disposalProof.vetoVerified, false);
          assert.deepEqual(saved.active.disposalProof.terminal, terminal);
          assert.equal(saved.lastDisposed, undefined);
          let before = operations(owned);
          t.diagnostic(
            JSON.stringify({
              scope: "controlled host disposal checkpoint, NOT guest qualification",
              checkpoint: published,
              checkpointOwnerEnded: ended,
              durablePhase: saved.active.phase,
              terminal: saved.active.disposalProof.terminal,
            }),
          );
          let recovery = protocolOwner(owned);
          owners.push(recovery);
          if (checkpoint === "before-stop") {
            const currentRevoked = await revokeDisposal(owned, recovery, saved.active);
            configureIdle(owned, { changedCut: false });
            const restored = await recovery.request("status");
            if (!restored.ok) {
              t.diagnostic(
                JSON.stringify({
                  currentRevoked,
                  refusedFreshRetry: restored,
                  failure: JSON.parse(
                    readFileSync(
                      join(owned.root, `${saved.active.name}.operator-failure.json`),
                      "utf8",
                    ),
                  ),
                }),
              );
            }
            assert.equal(restored.ok, true, JSON.stringify(restored));
            assert.equal(restored.result.phase, "stopping");
            assert.equal(restored.result.interruptedUnassigned, true);
            assert.deepEqual(currentRevoked, {
              phase: "idle-interrupting",
              interruptedUnassigned: false,
            });
            const coldRevoked = await revokeDisposal(owned, recovery, saved.active);
            recovery.child.stdin.end();
            assert.equal((await recovery.exit)[0], 1);
            const currentEnded = darwinSnapshot("", recovery.child.pid, Date.now() + 3000, true);
            assert.deepEqual(currentEnded.identities, []);
            assert.deepEqual(currentEnded.uncertainties, []);
            configureIdle(owned, { changedCut: false });
            recovery = protocolOwner(owned);
            owners.push(recovery);
            t.diagnostic(
              JSON.stringify({
                scope: "controlled fresh running reobservation, NOT native qualification",
                currentRevoked,
                currentRestored: restored.result,
                coldRevoked,
                previousOwnerEnded: currentEnded,
              }),
            );
          }
          const status = await recovery.request("status");
          if (!status.ok) {
            t.diagnostic(
              JSON.stringify({
                refusedStatus: status,
                operations: operations(owned),
                failure: JSON.parse(
                  readFileSync(
                    join(owned.root, `${saved.active.name}.operator-failure.json`),
                    "utf8",
                  ),
                ),
              }),
            );
          }
          assert.equal(status.ok, true, JSON.stringify(status));
          assert.equal(status.result.phase, saved.active.phase);
          assert.equal(status.result.interruptedUnassigned, true);
          assert.equal(status.result.transportEnded, true);
          assert.equal((await recovery.request("capture")).result.interruptedUnassigned, true);
          if (checkpoint !== "before-stop") {
            assert.deepEqual(operations(owned), before, "No connection or fresh native authority");
          }
          recovery.child.stdin.end();
          assert.deepEqual(await recovery.exit, [0, null], recovery.diagnostic());
          before = operations(owned);
          for (const patch of [
            {
              disposalProof: {
                ...saved.active.disposalProof,
                quiet: { ...saved.active.disposalProof.quiet, bootSeconds: 1001 },
              },
            },
            { disposalProof: { ...saved.active.disposalProof, sourceVerified: true } },
            { idleStopProof: undefined },
            { phase: "listener-running" },
            ...(checkpoint === "before-stop"
              ? []
              : [{ phase: "idle-interrupting", interruptedUnassigned: false }]),
          ]) {
            writeFileSync(
              owned.path,
              JSON.stringify({ ...saved, active: { ...saved.active, ...patch } }),
              { mode: 0o600 },
            );
            const malformed = protocolOwner(owned);
            owners.push(malformed);
            // The actual new owner must reject before any guest connection/deletion.
            // oxlint-disable-next-line no-await-in-loop
            const refused = await malformed.request("status");
            assert.equal(refused.ok, false);
            assert.equal(refused.retained, true);
            assert.deepEqual(operations(owned), before);
            if (patch.interruptedUnassigned === false) {
              // Exact terminal identity cannot substitute for revoked live native proof.
              // oxlint-disable-next-line no-await-in-loop
              const refusedSettle = await malformed.request("settle", { terminal });
              assert.equal(refusedSettle.ok, false);
              assert.equal(refusedSettle.retained, true);
              assert.deepEqual(operations(owned), before);
              const revoked = JSON.parse(readFileSync(owned.path, "utf8")).active;
              assert.equal(revoked.interruptedUnassigned, false);
              assert.equal(revoked.phase, "idle-interrupting");
              t.diagnostic(
                JSON.stringify({
                  nonRunningRevocationRetained: inventory,
                  phase: revoked.phase,
                  interruptedUnassigned: revoked.interruptedUnassigned,
                  guestCallsUnchanged: true,
                }),
              );
            }
            malformed.child.stdin.end();
            // Join the rejected owner before another variant replaces its shared journal.
            // oxlint-disable-next-line no-await-in-loop
            assert.equal((await malformed.exit)[0], 1);
          }
          writeFileSync(owned.path, JSON.stringify(saved), { mode: 0o600 });
          recovery = protocolOwner(owned);
          owners.push(recovery);
          assert.equal((await recovery.request("status")).ok, true);
          before = operations(owned);
          const newOwner = darwinSnapshot("", recovery.child.pid, Date.now() + 3000, true);
          assert.equal(newOwner.identities.length, 1);
          assert.deepEqual(newOwner.uncertainties, []);
          const invalid = await recovery.request("settle", {
            terminal: { ...terminal, runnerId: 78 },
          });
          assert.equal(invalid.ok, false);
          assert.equal(invalid.retained, true);
          assert.deepEqual(operations(owned), before);
          const disposed = await recovery.request("settle", { terminal });
          assert.equal(disposed.ok, true, JSON.stringify(disposed));
          assert.deepEqual(disposed.result, {
            phase: "disposed",
            disposed: true,
            transportEnded: true,
            sourceVerified: false,
            vetoVerified: false,
            interruptedUnassigned: true,
          });
          const replay = {
            ...disposed.result,
            operationID: owned.operationID,
            runnerName: "idle-fixture",
          };
          assert.deepEqual((await recovery.request("settle", { terminal })).result, replay);
          assert.equal(
            (await recovery.request("settle", { terminal: { ...terminal, canceled: true } })).ok,
            false,
          );
          recovery.child.stdin.end();
          assert.deepEqual(await recovery.exit, [0, null], recovery.diagnostic());
          const recoveryEnded = darwinSnapshot("", recovery.child.pid, Date.now() + 3000, true);
          assert.deepEqual(recoveryEnded.identities, []);
          assert.deepEqual(recoveryEnded.uncertainties, []);
          const final = JSON.parse(readFileSync(owned.path, "utf8"));
          assert.equal(final.active, null);
          assert.deepEqual(final.lastDisposed.interruptedTerminal, terminal);
          const calls = operations(owned);
          assert.equal(calls.filter((operation) => operation === "idle-drain").length, 1);
          assert.equal(calls.filter((operation) => operation === "stop").length, 1);
          assert.equal(calls.filter((operation) => operation === "delete").length, 1);
          assert.ok(!calls.includes("connect:stopped") && !calls.includes("connect:absent"));
          assert.ok(!existsSync(join(owned.root, "t")) && !existsSync(join(owned.root, "c")));
          const admitted = contender(owned.path);
          const capacity = await start(admitted);
          assert.equal(capacity.admitted, true);
          assert.equal(capacity.state.active, null);
          assert.equal(capacity.state.lastDisposed.interruptedUnassigned, true);
          admitted.child.stdin.end("release\n");
          assert.deepEqual(await admitted.exit, [0, null]);
          admitted.lines.close();
          t.diagnostic(
            JSON.stringify({
              scope: "controlled host disposal replay, NOT guest qualification",
              checkpoint: published,
              checkpointOwnerEnded: ended,
              recoveryOwner: newOwner,
              recoveryOwnerEnded: recoveryEnded,
              finalPhase: final.lastDisposed.phase,
              guardAdmitted: capacity.admitted,
            }),
          );
        } finally {
          await Promise.all(owners.map((owner) => releaseIdle(owned, owner)));
          rmSync(owned.root, { recursive: true, force: true });
        }
      });
    }
  },
);

test("SDK-canceled idle drain journals closure and exact terminal before failed guest connection", async () => {
  const owned = fixture();
  let controller;
  try {
    const state = JSON.parse(readFileSync(owned.path, "utf8"));
    const operationID = "00000000-0000-0000-0000-000000000001";
    state.active = {
      operationID,
      name: `${state.owner}-job-${operationID}`,
      jitSent: true,
      runnerId: 77,
      runnerName: "canceled-fixture",
      prepared: true,
      phase: "listener-running",
      windowClosed: true,
      completion: {
        ownerName: "fitchmultz",
        repositoryName: "pi-subagents",
        workflowRunId: 10,
        runnerRequestId: 9,
        jobId: "fixture-demand",
        runnerId: 77,
        runnerName: "canceled-fixture",
      },
    };
    writeFileSync(state.tart, "#!/bin/sh\nexit 7\n");
    chmodSync(state.tart, 0o700);
    writeFileSync(owned.path, JSON.stringify(state), { mode: 0o600 });
    const terminal = {
      noJob: true,
      canceled: true,
      runnerId: 77,
      runnerName: "canceled-fixture",
      requestId: 9,
      runId: 10,
      registrationAbsent: false,
    };
    controller = new NativeController(owned.path);
    await assert.rejects(
      controller.exchange({ version: 1, id: 1, operationID, action: "drain", terminal }),
      (error) => {
        assert.equal(error.diagnostic.status, 7);
        return true;
      },
    );
    const active = JSON.parse(readFileSync(owned.path, "utf8")).active;
    assert.equal(active.phase, "idle-draining");
    assert.equal(active.windowClosed, true);
    assert.deepEqual(active.idleTerminal, terminal);
    assert.notEqual(active.interruptedUnassigned, true);
  } finally {
    if (controller) {
      await assert.rejects(controller.close(), /failed \(exit 7\)/);
    }
    rmSync(owned.root, { recursive: true, force: true });
  }
});
