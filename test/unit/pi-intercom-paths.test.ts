import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  getBrokerRuntimeDir,
  getBrokerSocketPath,
  getPreviousBrokerSocketPaths,
  isOwnedBrokerSocket,
  prepareBrokerSocketPath,
} from "../../src/pi-intercom/broker/paths.ts";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";

function restoreEnvironment(t: test.TestContext): void {
  const original = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, original);
  });
}

test("default socket is pure, UID-scoped and independent of all session directories", (t) => {
  restoreEnvironment(t);
  delete process.env.PI_INTERCOM_RUNTIME_DIR;
  const uid = t.mock.property(process, "getuid", () => 501);
  for (const root of ["/first", "/second"]) {
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = `${root}/agent`;
    process.env.TMPDIR = `${root}/tmp`;
    assert.equal(getBrokerSocketPath(), "/tmp/pi-intercom-501/broker.sock");
  }
  uid.mock.mockImplementation(() => 502);
  assert.equal(getBrokerSocketPath(), "/tmp/pi-intercom-502/broker.sock");
});

test("explicit runtime directory isolates deployments without an implicit fallback", (t) => {
  restoreEnvironment(t);
  const runtimeDir = join(process.env.HOME ?? "", "isolated");
  process.env.PI_INTERCOM_RUNTIME_DIR = runtimeDir;
  assert.equal(getBrokerSocketPath(), join(runtimeDir, "broker.sock"));
  assert.equal(fs.existsSync(runtimeDir), false, "path lookup does not publish a directory");
  for (const invalid of ["relative", "", `/tmp/${"long/".repeat(30)}`]) {
    process.env.PI_INTERCOM_RUNTIME_DIR = invalid;
    assert.throws(() => getBrokerSocketPath(), /absolute short Unix socket directory/);
  }
});

test("runtime preparation rejects files, symlinks and foreign owners; owned directory is private", (t) => {
  restoreEnvironment(t);
  const runtimeDir = join(process.env.HOME ?? "", "unsafe");
  process.env.PI_INTERCOM_RUNTIME_DIR = runtimeDir;
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  fs.writeFileSync(runtimeDir, "blocked");
  assert.throws(() => prepareBrokerSocketPath());
  fs.unlinkSync(runtimeDir);
  fs.symlinkSync(dirname(runtimeDir), runtimeDir);
  assert.throws(() => prepareBrokerSocketPath(), /Unsafe intercom socket directory/);
  fs.unlinkSync(runtimeDir);
  fs.mkdirSync(runtimeDir, { mode: 0o755 });
  const uid = t.mock.property(process, "getuid", () => fs.statSync(runtimeDir).uid + 1);
  assert.throws(() => prepareBrokerSocketPath(), /Unsafe intercom socket directory/);
  uid.mock.restore();
  assert.equal(prepareBrokerSocketPath(), join(runtimeDir, "broker.sock"));
  assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o700);
});

test("client never falls back to either live previous namespace or mutates its socket", async (t) => {
  restoreEnvironment(t);
  process.env.PI_CODING_AGENT_DIR = join(process.env.HOME ?? "", "old-agent");
  // Keep the historical socket path short on macOS as well.
  process.env.TMPDIR = "/tmp";
  for (const legacyPath of getPreviousBrokerSocketPaths()) {
    fs.mkdirSync(dirname(legacyPath), { recursive: true });
    const server = net.createServer((socket) => {
      socket.destroy();
    });
    server.listen(legacyPath);
    // Readiness comes from the real listener, not a delay.
    // oxlint-disable-next-line no-await-in-loop
    await once(server, "listening");
    const before = fs.lstatSync(legacyPath);
    const client = new IntercomClient();
    try {
      // oxlint-disable-next-line no-await-in-loop
      await assert.rejects(
        client.connect({ name: "new-client", cwd: "/tmp", model: "test" }),
        /broker socket is unavailable/,
      );
      assert.equal(client.sessionId, null);
      assert.equal(isOwnedBrokerSocket(legacyPath), true);
      const link = `${legacyPath}.link`;
      fs.symlinkSync(legacyPath, link);
      assert.equal(isOwnedBrokerSocket(link), false);
      fs.unlinkSync(link);
      assert.equal(fs.lstatSync(legacyPath).ino, before.ino);
      assert.equal(fs.lstatSync(legacyPath).mode, before.mode);
    } finally {
      server.close();
      // oxlint-disable-next-line no-await-in-loop
      await once(server, "close");
      fs.rmSync(legacyPath, { force: true });
      if (legacyPath.endsWith("/broker.sock")) {
        fs.rmdirSync(dirname(legacyPath));
      }
    }
  }
  assert.equal(getBrokerRuntimeDir(), process.env.PI_INTERCOM_RUNTIME_DIR);
});
