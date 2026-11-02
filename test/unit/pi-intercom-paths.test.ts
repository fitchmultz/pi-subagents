import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import {
  agentObservationSocketPath,
  getBrokerRuntimeDir,
  getBrokerSocketPath,
  getPreviousBrokerSocketPaths,
  isOwnedBrokerSocket,
  prepareBrokerSocketPath,
  preparePrivateSocketPath,
} from "../../src/pi-intercom/broker/paths.ts";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";

function restoreEnvironment(t: TestContext): void {
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

nodeTest("default socket is pure, UID-scoped and independent of all session directories", (t) => {
  restoreEnvironment(t);
  t.mock.property(process, "platform", "linux");
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

nodeTest("Android defaults to its shared Termux prefix rather than session HOME or TMPDIR", (t) => {
  restoreEnvironment(t);
  t.mock.property(process, "platform", "android");
  t.mock.property(process, "getuid", () => 10442);
  delete process.env.PI_INTERCOM_RUNTIME_DIR;
  process.env.PREFIX = "/data/data/com.termux/files/usr";
  for (const root of ["/first", "/second"]) {
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = `${root}/agent`;
    process.env.TMPDIR = `${root}/tmp`;
    assert.equal(
      getBrokerSocketPath(),
      "/data/data/com.termux/files/usr/tmp/pi-intercom-10442/broker.sock",
    );
  }
  delete process.env.PREFIX;
  process.env.TMPDIR = "/native-android-tmp";
  assert.equal(getBrokerSocketPath(), "/native-android-tmp/pi-intercom-10442/broker.sock");
});

nodeTest(
  "explicit runtime namespace binds observation and isolates without fallback",
  async (t) => {
    restoreEnvironment(t);
    const socketPath = preparePrivateSocketPath(agentObservationSocketPath("test-namespace"));
    const server = net.createServer();
    try {
      server.listen(socketPath);
      await once(server, "listening");
    } finally {
      if (server.listening) {
        const closed = once(server, "close");
        server.close();
        await closed;
      }
      fs.rmdirSync(dirname(socketPath));
    }
    const runtimeDir = join(process.env.HOME ?? "", "isolated");
    process.env.PI_INTERCOM_RUNTIME_DIR = runtimeDir;
    assert.equal(getBrokerSocketPath(), join(runtimeDir, "broker.sock"));
    assert.equal(fs.existsSync(runtimeDir), false, "path lookup does not publish a directory");
    for (const invalid of ["relative", "", `/tmp/${"long/".repeat(30)}`]) {
      process.env.PI_INTERCOM_RUNTIME_DIR = invalid;
      assert.throws(() => getBrokerSocketPath(), /absolute short Unix socket directory/);
    }
  },
);

nodeTest(
  "runtime preparation rejects files, symlinks and foreign owners; owned directory is private",
  (t) => {
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
  },
);

nodeTest(
  "client never falls back to either live previous namespace or mutates its socket",
  async (t) => {
    restoreEnvironment(t);
    process.env.PI_CODING_AGENT_DIR = join(process.env.HOME ?? "", "old-agent");
    // Keep the historical socket path short on macOS as well.
    process.env.TMPDIR = process.platform === "android" ? tmpdir() : "/tmp";
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
  },
);
