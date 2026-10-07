import assert from "node:assert/strict";
import { ListenerTransport } from "./protected-macos-listener.mjs";

function idleIdentity(active) {
  return Object.fromEntries(
    [
      "operationID",
      "name",
      "runnerId",
      "runnerName",
      "returnedRunnerName",
      "listenerIdentity",
      "listenerTransportPid",
      "transportIdentity",
      "cut",
    ].map((key) => [key, active[key]]),
  );
}
function originalQuiet(quiet, cut) {
  assert.ok(cut);
  assert.equal(quiet.bootSeconds, cut.bootSeconds);
  assert.equal(quiet.bootMicroseconds, cut.bootMicroseconds);
  assert.equal(quiet.stableEnumerations, 2);
  assert.equal(quiet.uncertain, false);
  assert.equal(quiet.remaining, 0);
}

// Existing root idle-stop and attached transport phases; the controller still owns all resources.
export class IdleBoundary {
  #guest;
  #journal;
  #listener;
  constructor(guest, journal, listener) {
    this.#guest = guest;
    this.#journal = journal;
    this.#listener = listener;
  }
  static canInterrupt(active) {
    const phase =
      ["listener-running", "idle-interrupting", "idle-interrupted"].includes(active?.phase) ||
      active?.disposalProof?.interruptedUnassigned === true;
    return (
      active?.jitSent === true &&
      active.prepared === true &&
      phase &&
      ![
        "capture",
        "binding",
        "acked",
        "veto",
        "completion",
        "assignment",
        "source",
        "idleTerminal",
      ].some((key) => active[key])
    );
  }
  static #original(active) {
    assert.ok(IdleBoundary.canInterrupt(active));
    assert.equal(active.operatorEOF, true);
    assert.equal(active.windowClosed, true);
    assert.equal(active.transportEnded, true);
    const proof = active.idleInterruptionProof;
    assert.ok(proof && active.idleStopProof);
    assert.deepEqual(active.idleStopProof.identity, idleIdentity(active));
    assert.deepEqual(active.idleStopProof.drain, proof.drain);
    assert.deepEqual(proof.identity, idleIdentity(active));
    assert.equal(proof.drain.stoppedIdleListener, true);
    assert.equal(proof.listenerAbsent.listenerAbsent, true);
    originalQuiet(proof.quiet, active.cut);
  }
  static interrupted(active) {
    IdleBoundary.#original(active);
    assert.equal(active.interruptedUnassigned, true);
    assert.ok(
      active.phase === "idle-interrupted" || active.disposalProof?.interruptedUnassigned === true,
    );
  }
  static terminal(terminal, active) {
    IdleBoundary.interrupted(active);
    IdleBoundary.#terminalIdentity(terminal, active);
  }
  static #terminalIdentity(terminal, active) {
    assert.ok(Number.isSafeInteger(active.runnerId) && active.runnerId > 0);
    assert.equal(terminal?.interruptedUnassigned, true);
    assert.equal(terminal.noJob, true);
    assert.equal(terminal.runnerId, active.runnerId);
    assert.equal(terminal.runnerName, active.runnerName);
    assert.equal(terminal.registrationAbsent, true);
    for (const key of ["requestId", "runId", "attempt", "jobId"]) {
      assert.ok(terminal[key] === undefined || terminal[key] === 0, `No interrupted ${key}`);
    }
    assert.ok(terminal.conclusion === undefined || terminal.conclusion === "");
    assert.ok(terminal.canceled === undefined || terminal.canceled === false);
    assert.ok(terminal.vetoed === undefined || terminal.vetoed === false);
  }
  static disposal(active) {
    const proof = active.disposalProof;
    assert.equal(proof?.interruptedUnassigned, true);
    IdleBoundary.#original(active);
    IdleBoundary.#terminalIdentity(proof.terminal, active);
    assert.ok(["stopping", "deleting", "idle-interrupting"].includes(active.phase));
    assert.equal(active.interruptedUnassigned, active.phase !== "idle-interrupting");
    assert.equal(proof.sourceVerified, false);
    assert.equal(proof.vetoVerified, false);
    originalQuiet(proof.quiet, active.cut);
    // A revoked v1 transaction may resume stopping only after fresh running native proof.
    return active.phase === "idle-interrupting" ? "stopping" : active.phase;
  }
  static canceledProof(terminal, active) {
    assert.ok(active.idleTerminal && !active.capture && !active.binding);
    assert.ok(!active.acked && !active.veto);
    assert.deepEqual({ ...terminal, registrationAbsent: false }, active.idleTerminal);
    return { sourceVerified: false, vetoVerified: false };
  }
  static canceledTerminal(terminal, active) {
    assert.ok(active?.jitSent && !active.capture && !active.binding);
    assert.ok(!active.acked && !active.veto);
    assert.equal(terminal?.noJob, true);
    assert.notEqual(terminal.interruptedUnassigned, true);
    assert.equal(terminal.canceled, true);
    assert.ok(terminal.requestId > 0);
    assert.equal(terminal.registrationAbsent, false);
    assert.equal(terminal.runnerId, active.runnerId);
    assert.equal(terminal.runnerName, active.runnerName);
    assert.equal(terminal.runId, active.completion?.workflowRunId);
    assert.equal(terminal.requestId, active.completion?.runnerRequestId);
  }
  static beginDrain(terminal, journal) {
    IdleBoundary.canceledTerminal(terminal, journal.snapshot().active);
    journal.updateActive({
      phase: "idle-draining",
      windowClosed: true,
      idleTerminal: terminal,
    });
  }
  async #join() {
    if (this.#listener) {
      await this.#listener.join();
    }
    ListenerTransport.observe(this.#journal);
    assert.equal(this.#journal.snapshot().active.transportEnded, true);
  }
  async drain(terminal) {
    IdleBoundary.canceledTerminal(terminal, this.#journal.snapshot().active);
    this.#journal.receipt("idle-drain", this.#guest.drainIdle());
    await this.#join();
    this.#guest.listenerAbsent();
    this.#journal.receipt("idle-drain-native", await this.#guest.settled());
  }
  #unchanged(identity) {
    const active = this.#journal.snapshot().active;
    assert.ok(IdleBoundary.canInterrupt(active));
    assert.equal(active.operatorEOF, true);
    assert.deepEqual(idleIdentity(active), identity);
    return active;
  }
  #stop(identity) {
    const active = this.#unchanged(identity);
    if (active.idleStopProof) {
      assert.deepEqual(active.idleStopProof.identity, identity);
      assert.equal(active.idleStopProof.drain.stoppedIdleListener, true);
      const absent = this.#guest.listenerAbsent();
      assert.equal(absent.listenerAbsent, true);
      this.#journal.receipt("idle-interruption-resumed-root", absent);
      return active.idleStopProof;
    }
    const drain = this.#guest.drainIdle();
    this.#journal.receipt("idle-interruption-root", drain);
    // Mere absence on first observation does not establish that this owner stopped an idle job.
    assert.equal(drain.stoppedIdleListener, true);
    const proof = { identity, drain };
    this.#journal.updateActive({ phase: "idle-interrupting", idleStopProof: proof });
    return proof;
  }
  async interrupt() {
    const active = this.#journal.snapshot().active;
    if (active.phase !== "listener-running") {
      assert.ok(active.idleStopProof, "Resume requires the original idle-stop proof");
    }
    if (active.interruptedUnassigned) {
      IdleBoundary.interrupted(active);
    }
    assert.ok(active.cut && active.listenerIdentity && active.transportIdentity);
    assert.ok(Number.isSafeInteger(active.runnerId) && active.runnerId > 0);
    assert.equal(active.returnedRunnerName, active.runnerName);
    assert.equal(active.transportIdentity.pid, active.listenerTransportPid);
    this.#journal.updateActive({ interruptedUnassigned: false, phase: "idle-interrupting" });
    const identity = idleIdentity(active),
      stop = this.#stop(identity);
    await this.#join();
    this.#unchanged(identity);
    const listenerAbsent = this.#guest.listenerAbsent();
    assert.equal(listenerAbsent.listenerAbsent, true);
    const quiet = await this.#guest.settled();
    originalQuiet(quiet, identity.cut);
    this.#unchanged(identity);
    const proof = { ...stop, listenerAbsent, quiet };
    this.#journal.receipt("idle-interruption", proof);
    this.#journal.updateActive({
      phase: "idle-interrupted",
      interruptedUnassigned: true,
      idleInterruptionProof: proof,
    });
  }
  async settleInterrupted(terminal) {
    const active = this.#journal.snapshot().active;
    IdleBoundary.terminal(terminal, active);
    await this.reobserveInterrupted();
    IdleBoundary.terminal(terminal, this.#journal.snapshot().active);
    this.#journal.receipt("interrupted-unassigned-settlement", terminal);
    return { interruptedUnassigned: true, sourceVerified: false, vetoVerified: false };
  }
  async disposalInventory() {
    const active = this.#journal.snapshot().active;
    const phase = IdleBoundary.disposal(active);
    let inventory;
    try {
      inventory = this.#guest.status();
      assert.ok(["running", "stopped", "absent"].includes(inventory));
      if (inventory === "running") {
        await this.#guest.connect();
        await this.#reobserve();
        const current = this.#journal.snapshot().active;
        assert.equal(IdleBoundary.disposal(current), phase);
        assert.deepEqual(current.disposalProof, active.disposalProof);
        this.#journal.updateActive({
          interruptedUnassigned: true,
          phase,
        });
      } else {
        assert.equal(
          active.interruptedUnassigned,
          true,
          "Revoked native proof requires reobservation",
        );
      }
    } catch (error) {
      this.#revoke();
      throw error;
    }
    // The committed terminal/original proof authorizes this transaction, not fresh idle absence.
    this.#journal.receipt("interrupted-disposal-inventory", { phase: active.phase, inventory });
    return inventory;
  }
  static recovering(active) {
    return (
      active?.interruptedUnassigned === true ||
      (active?.phase === "idle-interrupting" && Boolean(active.idleStopProof))
    );
  }
  async resume() {
    if (this.#journal.snapshot().active.interruptedUnassigned) {
      await this.reobserveInterrupted();
    } else {
      await this.interrupt();
    }
  }
  async #reobserve() {
    const active = this.#journal.snapshot().active;
    IdleBoundary.#original(active);
    await this.#join();
    const absent = this.#guest.listenerAbsent();
    assert.equal(absent.listenerAbsent, true);
    const quiet = await this.#guest.settled();
    originalQuiet(quiet, active.cut);
    const current = this.#journal.snapshot().active;
    IdleBoundary.#original(current);
    assert.deepEqual(idleIdentity(current), idleIdentity(active));
    this.#journal.receipt("idle-interruption-reobserved", { absent, quiet });
  }
  async reobserveInterrupted() {
    try {
      IdleBoundary.interrupted(this.#journal.snapshot().active);
      await this.#reobserve();
      IdleBoundary.interrupted(this.#journal.snapshot().active);
    } catch (error) {
      this.#revoke();
      throw error;
    }
  }
  #revoke() {
    this.#journal.updateActive({
      interruptedUnassigned: false,
      phase: "idle-interrupting",
    });
  }
  async close(failure) {
    let retained = failure;
    try {
      if (this.#guest) {
        const closed = this.#guest.closeGate();
        assert.equal(closed.windowClosed, true);
        this.#journal.receipt("operator-eof-gate", closed);
        if (IdleBoundary.canInterrupt(this.#journal.snapshot().active)) {
          await this.interrupt();
        }
      }
    } catch (error) {
      retained ??= error;
    }
    try {
      if (this.#listener) {
        await this.#listener.join();
      }
    } catch (error) {
      retained ??= error;
    }
    if (retained) {
      throw retained;
    }
  }
}
