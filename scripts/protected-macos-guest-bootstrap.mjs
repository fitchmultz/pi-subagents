import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, isIPv4 } from "node:net";
import { join } from "node:path";
import { inventory } from "./protected-macos-network.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { execute, observeReadiness } from "./protected-macos-transport.mjs";
import { observerInputs } from "./protected-macos-observer-build.mjs";

export const GUEST_PATH =
  "/bin:/usr/bin:/usr/sbin:/sbin:/Users/ci/tools/node/bin:/Users/ci/tools/go/bin:/opt/homebrew/bin";
// Owns one actual guest connection and its native boundary, not the runner/journal.
// Root operations use only root-owned native programs, never the CI toolchain.
export class GuestBoundary {
  #configuration;
  #name;
  #ip;
  constructor(configuration, name) {
    this.#configuration = Object.fromEntries(
      [
        "owner",
        "root",
        "tart",
        "tartHome",
        "key",
        "knownHosts",
        "private",
        "gateway",
        "observer",
      ].map((key) => [key, configuration[key]]),
    );
    this.#name = this.#ownedName(name);
  }
  #ownedName(name) {
    assert.match(
      name,
      new RegExp(
        `^${this.#configuration.owner}-(?:bootstrap|qualified(?:-[a-f0-9]{8})?|job-[a-f0-9-]{36})$`,
      ),
    );
    return name;
  }
  #tart(args) {
    return execute(this.#configuration.tart, args, {
      env: {
        HOME: process.env.HOME,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TART_HOME: this.#configuration.tartHome,
        TART_NO_AUTO_PRUNE: "1",
      },
    });
  }
  clone(source) {
    this.#tart(["clone", this.#ownedName(source), this.#name]);
    if (this.#name.includes("-job-")) {
      this.#tart(["set", this.#name, "--random-mac"]);
    }
  }
  async connect() {
    this.#ip = this.#tart(["ip", this.#name, "--wait", "120"]).trim();
    assert.ok(isIPv4(this.#ip));
    await observeReadiness(() => {
      try {
        this.#ssh("admin", "/usr/bin/true");
        return true;
      } catch {
        return false;
      }
    }, "guest SSH readiness");
    return this.#ip;
  }
  async start() {
    const log = openSync(join(this.#configuration.root, `${this.#name}.vm.log`), "a", 0o600);
    const child = spawn(
      this.#configuration.tart,
      ["run", "--no-graphics", "--no-audio", "--no-clipboard", "--no-usb-accessories", this.#name],
      {
        env: {
          HOME: process.env.HOME,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TART_HOME: this.#configuration.tartHome,
          TART_NO_AUTO_PRUNE: "1",
        },
        stdio: ["ignore", log, log],
        detached: true,
      },
    );
    closeSync(log);
    child.on("error", (error) => {
      console.error(`Owned Tart failed: ${error.message}`);
    });
    child.unref(); // Uncertainty retains the diagnostic VM, but must not hang a failed CLI.
    return { ip: await this.connect(), pid: child.pid };
  }
  connectionArgs(user = "ci") {
    assert.ok(isIPv4(this.#ip));
    return [
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${this.#configuration.knownHosts}`,
      "-o",
      `HostKeyAlias=${this.#configuration.owner}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=2",
      "-i",
      this.#configuration.key,
      `${user}@${this.#ip}`,
    ];
  }
  #ssh(user, request) {
    const command = typeof request === "string" ? request : request.command;
    const input = typeof request === "string" ? "" : request.input;
    const timeout = typeof request === "string" ? 300000 : (request.timeout ?? 300000);
    return execute("/usr/bin/ssh", [...this.connectionArgs(user), command], {
      input,
      timeout,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      diagnosticPath: join(this.#configuration.root, `${this.#name}.transport.json`),
    });
  }
  ci(command) {
    return this.#ssh("ci", command);
  }
  root(command, input = "") {
    const password = JSON.parse(readFileSync(this.#configuration.private, "utf8")).adminPassword;
    assert.ok(typeof password === "string" && password.length >= 32);
    return execute(
      "/usr/bin/ssh",
      [...this.connectionArgs("admin"), `sudo -S -p '' /bin/bash -c '${command}'`],
      {
        input: `${password}\n${input}`,
        timeout: 10000,
        secrets: [password],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
        diagnosticPath: join(this.#configuration.root, `${this.#name}.root-failure.json`),
      },
    );
  }
  security() {
    const rules = this.root(
      'set -e; /sbin/pfctl -s info; /sbin/pfctl -sr; /usr/sbin/sshd -T; /usr/bin/stat -f "%Su %Sp %N" /Library/ProtectedCI /Library/ProtectedCI/load-pf.sh /Library/ProtectedCI/pf.conf /dev/pf /Library/ProtectedCIHooks /Library/ProtectedCIHooks/job-started.sh /Library/ProtectedCIHooks/runner-launch.sh /Library/Developer/CommandLineTools /Library/Developer/CommandLineTools/usr /Library/Developer/CommandLineTools/usr/bin /Library/Developer/CommandLineTools/usr/bin/clang /Library/Developer/CommandLineTools/SDKs; if /bin/test -e /etc/kcpassword || /usr/bin/grep -R NOPASSWD /etc/sudoers /etc/sudoers.d || /bin/launchctl print gui/501 >/dev/null 2>&1; then exit 1; fi',
    );
    assert.match(rules, /Status: Enabled/);
    assert.match(rules, /block drop quick inet6 all/);
    assert.match(rules, /block return quick inet from any to <desktop>/);
    assert.ok(!/anchor|skip/.test(rules.split("permitrootlogin")[0]));
    assert.match(rules, /permituserenvironment no/);
    assert.match(rules, /permituserrc no/);
    assert.ok(!/^acceptenv /m.test(rules), "SSH environment overrides must remain disabled");
    const ci = this.ci(
      "set -e; id; if sudo -n /usr/bin/true || /sbin/pfctl -d || test -w /Library/ProtectedCI || test -r /Library/ProtectedCI/pf.conf || test -r /Users/admin/.ssh/authorized_keys || test -w /etc/sudoers || test -w /Library/LaunchDaemons/com.fitchmultz.protected-ci-pf.plist || (: >> /Library/ProtectedCI/load-pf.sh); then echo 'boundary=CI-privilege-or-PF' >&2; exit 1; fi; for path in /Library /Library/ProtectedCIHooks /Library/ProtectedCIHooks/job-started.sh /Library/ProtectedCIHooks/runner-launch.sh /Library/Developer /Library/Developer/CommandLineTools /Library/Developer/CommandLineTools/usr /Library/Developer/CommandLineTools/usr/bin /Library/Developer/CommandLineTools/usr/bin/clang /Library/Developer/CommandLineTools/SDKs; do if test -w \"$path\"; then printf 'boundary=privileged-input-writable %s\\n' \"$path\" >&2; exit 1; fi; done",
    );
    assert.match(ci, /uid=502\(ci\)/);
    assert.ok(!ci.includes("80(admin)"));
    return { rules, ci };
  }
  async network() {
    const snapshot = inventory();
    this.#ssh("admin", {
      command: "/bin/bash -c 'umask 077; /bin/cat > /Users/admin/blocked.pending'",
      input: snapshot.blocked,
    });
    this.root(
      "set -e; /usr/bin/install -o root -g wheel -m 600 /Users/admin/blocked.pending /Library/ProtectedCI/blocked.txt; /sbin/pfctl -t desktop -T replace -f /Library/ProtectedCI/blocked.txt; /bin/rm /Users/admin/blocked.pending; /sbin/pfctl -s info; /sbin/pfctl -sr",
    );
    const connections = [];
    const failures = [];
    const server = createServer((socket) => {
      connections.push(socket.remoteAddress);
      socket.on("error", (error) => {
        // nc -z closes a successful positive-control connection immediately.
        // Other endpoint errors invalidate the owner-side network receipt.
        if (error.code !== "ECONNRESET") {
          failures.push(error);
        }
      });
      socket.end("OWN-CI-DUMMY\n");
    });
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(443, "0.0.0.0", resolveListen);
    });
    let receipt;
    try {
      const port = server.address().port;
      const gateway = this.#configuration.gateway;
      const hostAddress = [...snapshot.interfaces.matchAll(/inet (\d+\.\d+\.\d+\.\d+) netmask/g)]
        .map((match) => match[1])
        .find((address) => !address.startsWith("127.") && address !== gateway);
      assert.ok(hostAddress);
      execute("/usr/bin/nc", ["-G", "5", "-z", gateway, String(port)]);
      execute("/usr/bin/nc", ["-G", "5", "-z", hostAddress, String(port)]);
      await observeReadiness(() => connections.length === 2, "owner dummy positive controls", 5000);
      const publicEgress = this.ci(
        `set -e; if /usr/bin/nc -G 5 -z ${gateway} ${port} || /usr/bin/nc -G 5 -z ${hostAddress} ${port}; then exit 1; fi; /usr/bin/curl -fsS -o /dev/null -w '%{http_code}' --max-time 20 https://github.com`,
      );
      assert.equal(publicEgress, "200", "Public GitHub HTTPS must actually succeed");
      const rules = this.root("/sbin/pfctl -vvsr");
      receipt = {
        port,
        hostAddress,
        gateway,
        connections,
        publicEgress,
        rules,
        snapshot,
        inventoryHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
      };
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    assert.equal(
      connections.length,
      2,
      "No guest connection may reach the independently published own endpoint",
    );
    assert.deepEqual(failures, []);
    return receipt;
  }
  uploadCI(name, content) {
    assert.match(name, /^protected-macos-[A-Za-z0-9.-]+$/);
    return this.#ssh("ci", {
      command: `/bin/bash -c 'umask 077; /bin/cat > /Users/ci/${name}'`,
      input: content,
    });
  }
  recordTransport(phase, observation) {
    assert.match(phase, /^[A-Za-z0-9_.-]{1,128}$/);
    appendFileSync(
      join(this.#configuration.root, `${this.#name}.host-transports.ndjson`),
      `${JSON.stringify({ phase, observation })}\n`,
      { mode: 0o600 },
    );
  }
  sockets(pid) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    try {
      return JSON.parse(this.root(`/Library/ProtectedCI/quiescence --job-sockets ${pid}`));
    } catch (error) {
      if (error.diagnostic?.status !== 1) {
        throw error;
      }
      const observation = JSON.parse(error.diagnostic.stdout);
      assert.equal(observation.noListeners, false);
      assert.equal(observation.uncertain, false);
      return observation;
    }
  }
  native() {
    return JSON.parse(
      this.ci(
        `export PATH=${GUEST_PATH}; exec node /Users/ci/protected-macos-guest-probe.mjs /Users/ci/source`,
      ),
    );
  }
  installObserver() {
    const observer = this.#configuration.observer;
    assert.ok(observer, "Legitimately signed EndpointSecurity observer input unavailable");
    const manifest = JSON.parse(readFileSync(observer.manifest, "utf8"));
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.source, observerInputs(), "Signed observer source inputs changed");
    const binary = readFileSync(observer.binary);
    assert.equal(createHash("sha256").update(binary).digest("hex"), observer.sha256);
    for (const name of [
      "protected-macos-guest.sh",
      "protected-macos-quiescence.c",
      "protected-macos-prejob.h",
      "protected-macos-arguments.h",
      "protected-macos-files.h",
      "protected-macos-runner-inputs.h",
      "protected-macos-sockets.h",
      "protected-macos-lifecycle.h",
      "protected-macos-lifecycle-es.h",
      "protected-macos-lifecycle-publication.h",
      "protected-macos-source-identity.h",
      "protected-macos-private-logs.c",
      "protected-macos-source-files.c",
      "protected-macos-runner-integrity.tsv",
      "protected-macos-job-started.sh",
      "protected-macos-runner-launch.sh",
    ]) {
      this.#ssh("admin", {
        command: `/bin/bash -c 'umask 077; /bin/cat > /Users/admin/${name}'`,
        input: readFileSync(new URL(name, import.meta.url), "utf8"),
      });
    }
    this.#ssh("admin", {
      command: "/bin/bash -c 'umask 077; /bin/cat > /Users/admin/protected-macos-observer-signed'",
      input: binary,
    });
    this.root(
      `/bin/bash /Users/admin/protected-macos-guest.sh --install-observer ${observer.sha256}`,
    );
  }
  warm() {
    this.ci(
      `set -e; export PATH=${GUEST_PATH}; node --version; clang --version; git --version; codesign -dv /bin/sleep 2>&1; brew --version`,
    );
  }
  cut() {
    return JSON.parse(this.root("/Library/ProtectedCI/quiescence --snapshot"));
  }
  listener(pid) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const source = JSON.parse(this.root("/Library/ProtectedCI/quiescence --job-source-status"));
    assert.equal(source.subscriptionReady, true, "Prospective subscription must precede JIT");
    return JSON.parse(this.root(`/Library/ProtectedCI/quiescence --listener-admit ${pid}`));
  }
  listenerAbsent() {
    return JSON.parse(this.root("/Library/ProtectedCI/quiescence --listener-absent"));
  }
  listenerLaunch() {
    const password = JSON.parse(readFileSync(this.#configuration.private, "utf8")).adminPassword;
    assert.ok(typeof password === "string" && password.length >= 32);
    const command = "sudo -S -p '' /Library/ProtectedCIHooks/observer --job-observe";
    return { args: [...this.connectionArgs("admin"), command], password };
  }
  prepareGate(active) {
    assert.match(active.operationID, /^[a-f0-9-]{36}$/);
    assert.match(active.nonce, /^[a-f0-9]{64}$/);
    assert.match(active.runnerName, /^[A-Za-z0-9_-]{1,128}$/);
    assert.match(active.workerSHA256, /^[a-f0-9]{64}$/);
    return JSON.parse(
      this.root(
        `/Library/ProtectedCI/quiescence --job-prepare ${active.operationID} ${active.nonce} ${active.runnerName} ${active.workerSHA256}`,
      ),
    );
  }
  capture() {
    return JSON.parse(this.root("/Library/ProtectedCI/quiescence --job-capture"));
  }
  closeGate() {
    return JSON.parse(this.root("/Library/ProtectedCI/quiescence --job-close"));
  }
  acknowledge(nonce) {
    assert.match(nonce, /^[a-f0-9]{64}$/);
    return JSON.parse(this.root(`/Library/ProtectedCI/quiescence --job-ack ${nonce}`));
  }
  vetoStatus() {
    return JSON.parse(this.root("/Library/ProtectedCI/quiescence --job-veto-status"));
  }
  drainIdle() {
    return JSON.parse(this.root("/Library/ProtectedCI/quiescence --job-drain"));
  }
  sourceFiles(manifest) {
    assert.ok(Buffer.byteLength(manifest) <= 1048576);
    const lifecycle = JSON.parse(this.root("/Library/ProtectedCI/quiescence --job-source-ended"));
    assert.equal(lifecycle.originalConsumerExited, true);
    assert.equal(lifecycle.uncertain, false);
    return {
      ...JSON.parse(this.root("/Library/ProtectedCI/source-files", manifest)),
      lifecycle,
    };
  }
  logs() {
    const receipt = JSON.parse(this.root("/Library/ProtectedCI/private-logs"));
    assert.ok(receipt.totalBytes <= 2097152 && receipt.files.length <= 32);
    for (const file of receipt.files) {
      assert.match(file.name, /^[A-Za-z0-9_.-]{1,199}\.log$/);
      assert.match(file.hex, /^[a-f0-9]*$/);
      assert.ok(file.hex.length <= 1048576);
      writeFileSync(
        join(this.#configuration.root, `${this.#name}.${file.name}`),
        Buffer.from(file.hex, "hex"),
        { mode: 0o600 },
      );
    }
    return {
      ...receipt,
      files: receipt.files.map(({ name, truncated, hex }) => ({
        name,
        truncated,
        bytes: hex.length / 2,
      })),
    };
  }
  status() {
    const vms = JSON.parse(this.#tart(["list", "--source", "local", "--format", "json"]));
    const matches = vms.filter((vm) => vm.Name === this.#name);
    assert.ok(matches.length <= 1, "Ambiguous owned VM inventory");
    return matches[0]?.State ?? "absent";
  }
  quiescence(empty = false) {
    const observation = JSON.parse(
      this.root(`/Library/ProtectedCI/quiescence${empty ? " --empty" : ""}`),
    );
    assert.equal(observation.stableEnumerations, 2);
    assert.equal(observation.uncertain, false);
    assert.equal(observation.remaining, 0);
    return observation;
  }
  async settled(empty = false) {
    const deadline = Date.now() + 10000;
    const failures = [];
    while (true) {
      try {
        return this.quiescence(empty);
      } catch (error) {
        failures.push(error.diagnostic ?? { code: error.code });
        writeFileSync(
          join(this.#configuration.root, `${this.#name}.native-settlement-private.json`),
          JSON.stringify(failures.slice(-10), null, 2),
          { mode: 0o600 },
        );
        if (Date.now() >= deadline) {
          throw error;
        }
      }
      // Native churn requires the next actual observation, within the unchanged10s budget.
      // oxlint-disable-next-line no-await-in-loop
      await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
  }
  stop() {
    this.#tart(["stop", this.#name]);
  }
  delete() {
    assert.match(this.#name, new RegExp(`^${this.#configuration.owner}-job-[a-f0-9-]{36}$`));
    this.#tart(["delete", this.#name]);
  }
}
