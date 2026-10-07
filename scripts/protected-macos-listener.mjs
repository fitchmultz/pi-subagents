import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { darwinSnapshot } from "./compat-process-darwin.mjs";

function hostIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const observed = darwinSnapshot("", pid, Date.now() + 3000, true);
  assert.deepEqual(observed.uncertainties, []);
  assert.ok(observed.identities.length <= 1);
  return observed.identities[0];
}

function privateOutput(path) {
  const fd = openSync(path, "a", 0o600);
  let available = 2097152;
  return {
    append(chunk) {
      const used = Math.min(chunk.length, available);
      if (used > 0) {
        writeSync(fd, chunk.subarray(0, used));
        available -= used;
      }
    },
    close() {
      closeSync(fd);
    },
  };
}
// This owner stays attached through EOF, failed readiness and actual SSH return.
// The journal is shared with capture/bind; asynchronous exit never saves a clone.
export class ListenerTransport {
  #guest;
  #journal;
  #child;
  #outcome;
  constructor(guest, journal) {
    this.#guest = guest;
    this.#journal = journal;
  }
  async launch(jit) {
    assert.equal(this.#child, undefined, "One official transport per operation");
    const state = this.#journal.snapshot();
    const output = privateOutput(join(state.root, `${state.active.name}.listener-private.log`));
    const launch = this.#guest.listenerLaunch();
    const child = spawn("/usr/bin/ssh", launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    });
    this.#child = child;
    let inputError;
    const exit = new Promise((resolveExit) => {
      child.once("error", (error) => resolveExit({ errorCode: error.code }));
      child.stdin.once("error", (error) => {
        inputError = error.code;
      });
      child.once("close", (code, signal) => resolveExit({ code, signal, inputError }));
    });
    this.#outcome = exit
      .then((result) => {
        output.close();
        this.#journal.updateActive({ listenerOutcome: result, transportEnded: true });
        return result;
      })
      .catch((error) => {
        this.#journal.recordFailure(error);
        return { persistenceFailed: true };
      });
    const publication = this.#publication(child, output);
    child.stderr.on("data", (chunk) => output.append(chunk));
    try {
      const transportIdentity = hostIdentity(child.pid);
      assert.ok(transportIdentity && transportIdentity.uid === process.getuid());
      this.#journal.updateActive({
        listenerTransportPid: child.pid,
        transportIdentity,
        phase: "listener-admitting",
      });
      child.stdin.write(`${launch.password}\n`);
      launch.password = "";
      const published = await publication;
      if (published.error) {
        throw published.error;
      }
      const pid = published.pid;
      const listenerIdentity = this.#guest.listener(pid);
      this.#journal.updateActive({ listenerIdentity, jitSent: true, phase: "listener-running" });
      child.stdin.end(`${jit}\n`);
    } catch (error) {
      child.stdin.end();
      this.#journal.recordFailure(error);
      throw error;
    }
  }
  #publication(child, output) {
    let text = "";
    return new Promise((resolvePid) => {
      const finish = (result) => {
        clearTimeout(timer);
        resolvePid(result);
      };
      const timer = setTimeout(
        () => finish({ error: new Error("Listener native publication timed out; retain") }),
        120000,
      );
      child.stdout.on("data", (chunk) => {
        output.append(chunk);
        if (text.includes("\n")) {
          return;
        }
        text += chunk.toString("utf8");
        if (text.length > 4096) {
          finish({ error: new Error("Listener publication exceeded its bound") });
          text += "\n";
          return;
        }
        if (!text.includes("\n")) {
          return;
        }
        const match = /^PROTECTED_LISTENER (\d+)$/.exec(text.split("\n")[0]);
        if (match) {
          finish({ pid: Number(match[1]) });
        } else {
          finish({ error: new Error("Listener native publication invalid; retain") });
        }
      });
      child.once("error", (error) => finish({ error }));
      child.once("close", () =>
        finish({ error: new Error("Listener exited before native publication") }),
      );
    });
  }
  static observe(journal) {
    const active = journal.snapshot().active;
    if (!active?.listenerTransportPid || active.transportEnded) {
      return;
    }
    const saved = active.transportIdentity;
    assert.ok(saved, "Lost SSH identity retains transport uncertainty");
    const current = hostIdentity(saved.pid);
    if (!current) {
      journal.updateActive({ transportEnded: true });
      return;
    }
    assert.deepEqual(current, saved, "Changed/reused SSH incarnation retains uncertainty");
  }
  async join() {
    if (this.#outcome) {
      await this.#outcome;
    }
  }
}
