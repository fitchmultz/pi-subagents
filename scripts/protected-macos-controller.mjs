import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { GuestBoundary } from "./protected-macos-guest-bootstrap.mjs";
import { NativeJournal } from "./protected-macos-journal.mjs";
import { IdleBoundary } from "./protected-macos-idle.mjs";
import { ListenerTransport } from "./protected-macos-listener.mjs";
import {
  checkoutManifest,
  terminalIdentity,
  freezeBinding,
  guardedCapture,
  WORKER_SHA256,
} from "./protected-macos-source.mjs";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

// One resource/journal owner for the SDK's attached per-job adapter.
export class NativeController {
  #journal;
  #guest;
  #listener;
  constructor(path) {
    this.#journal = new NativeJournal(path);
  }
  async exchange(request) {
    assert.equal(request.version, 1);
    assert.ok(Number.isSafeInteger(request.id) && request.id > 0);
    assert.match(
      request.operationID,
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
    const state = this.#journal.snapshot();
    if (state.active) {
      assert.equal(
        request.operationID,
        state.active.operationID,
        "A foreign operation cannot control retained resources",
      );
      if (request.completion) {
        await this.#complete(request.completion);
      }
    } else if (state.lastDisposed?.operationID === request.operationID) {
      assert.ok(["status", "settle"].includes(request.action));
      const { interruptedTerminal, ...disposed } = state.lastDisposed;
      if (disposed.interruptedUnassigned && request.action === "settle") {
        assert.deepEqual(request.terminal, interruptedTerminal);
      }
      return disposed;
    }
    assert.ok(
      ["prepare", "status", "launch", "capture", "bind", "drain", "settle"].includes(
        request.action,
      ),
    );
    return await this[request.action](request);
  }
  async #connect() {
    if (!this.#guest) {
      const state = this.#journal.snapshot();
      assert.ok(state.active);
      const guest = new GuestBoundary(state, state.active.name);
      await guest.connect();
      this.#guest = guest;
    }
    return this.#guest;
  }
  async #complete(completion) {
    const active = this.#journal.snapshot().active;
    assert.equal(completion.ownerName, "fitchmultz");
    assert.equal(completion.repositoryName, "pi-subagents");
    assert.ok(completion.runnerRequestId > 0 && completion.workflowRunId > 0 && completion.jobId);
    if (completion.runnerId > 0) {
      assert.equal(completion.runnerId, active.runnerId);
      assert.equal(completion.runnerName, active.runnerName);
    }
    if (active.completion) {
      assert.deepEqual(completion, active.completion);
      return;
    }
    // Persist closure before any new source read; a root failure still leaves it closed.
    this.#journal.updateActive({ completion, windowClosed: true });
    if (active.jitSent && !active.acked) {
      (await this.#connect()).closeGate();
    }
  }
  async prepare(request) {
    const state = this.#journal.snapshot();
    if (state.active) {
      if (!state.active.prepared) {
        await this.#resumePreparation();
      }
      return this.#reply();
    }
    assert.equal(request.repository, "fitchmultz/pi-subagents");
    assert.match(request.runnerName, /^[A-Za-z0-9_-]{1,128}$/);
    assert.equal(digest(readFileSync(state.qualification)), state.qualificationHash);
    const qualification = JSON.parse(readFileSync(state.qualification, "utf8"));
    assert.equal(qualification.nativeGuard?.diagnosticsDisabledProved, true);
    assert.equal(qualification.nativeGuard?.tamperDenied, true);
    assert.equal(qualification.nativeGuard?.nativeSocketControls, true);
    assert.equal(qualification.nativeGuard?.workerSHA256, WORKER_SHA256);
    assert.equal(
      await fileDigest(join(state.tartHome, "vms", state.baseline, "disk.img")),
      state.baselineDiskHash,
    );
    const name = `${state.owner}-job-${randomUUID()}`;
    this.#guest = new GuestBoundary(state, name);
    assert.equal(this.#guest.status(), "absent");
    this.#journal.setActive({
      name,
      operationID: request.operationID,
      runnerName: request.runnerName,
      phase: "cloning",
      runnerId: null,
      jitSent: false,
      started: false,
      ciStarted: false,
      nonce: randomBytes(32).toString("hex"),
      workerSHA256: WORKER_SHA256,
    });
    await this.#resumePreparation();
    return this.#reply();
  }
  async #resumePreparation() {
    const state = this.#journal.snapshot(),
      active = state.active;
    assert.ok(active && !active.jitSent && active.runnerId === null);
    if (!this.#guest) {
      this.#guest = new GuestBoundary(state, active.name);
    }
    if (active.phase === "cloning") {
      const inventory = this.#guest.status();
      if (inventory === "absent") {
        this.#guest.clone(state.baseline);
      } else {
        assert.equal(inventory, "stopped");
        assert.equal(
          await fileDigest(join(state.tartHome, "vms", active.name, "disk.img")),
          state.baselineDiskHash,
          "Interrupted clone must match the complete pristine disk",
        );
      }
      this.#journal.updateActive({ phase: "starting", started: true });
    }
    if (this.#journal.snapshot().active.phase === "starting") {
      await this.#startFoundation();
    } else {
      await this.#guest.connect();
    }
    const phase = this.#journal.snapshot().active.phase;
    assert.equal(
      phase,
      "qualifying",
      "Interrupted foundation work without its original completed cut retains",
    );
    await this.#qualify();
    this.#guest.prepareGate(this.#journal.snapshot().active);
    this.#journal.updateActive({ phase: "prepared", prepared: true });
  }
  async #startFoundation() {
    const inventory = this.#guest.status();
    assert.ok(["stopped", "running"].includes(inventory));
    const connection =
      inventory === "stopped" ? await this.#guest.start() : { ip: await this.#guest.connect() };
    this.#journal.updateActive({
      ip: connection.ip,
      vmPid: connection.pid,
      phase: "warming",
      ciStarted: true,
    });
    this.#guest.installObserver();
    this.#guest.warm();
    const cut = this.#guest.cut();
    this.#journal.updateActive({ phase: "qualifying", cut });
    this.#journal.receipt("pre-job-cut", cut);
  }
  async #qualify() {
    this.#journal.receipt("privilege", this.#guest.security());
    this.#journal.receipt("network", await this.#guest.network());
    this.#journal.receipt("native", this.#guest.native());
    this.#journal.receipt("pre-registration-native", await this.#guest.settled());
  }
  async launch(request) {
    const active = this.#journal.snapshot().active;
    assert.ok(active?.prepared);
    if (active.jitSent) {
      return this.#reply();
    }
    // Preserve the actual SDK-returned identity before later launch assertions.
    assert.ok(Number.isSafeInteger(request.runnerID) && request.runnerID > 0);
    this.#journal.updateActive({
      runnerId: request.runnerID,
      returnedRunnerName: request.runnerName,
      scaleSetId: request.scaleSetId,
    });
    assert.equal(request.runnerName, active.runnerName);
    assert.equal(request.repository, "fitchmultz/pi-subagents");
    assert.ok(request.scaleSetId > 0);
    assert.ok(
      typeof request.jitConfig === "string" &&
        request.jitConfig.length > 0 &&
        !request.jitConfig.includes("\n"),
    );
    assert.equal(active.windowClosed, undefined, "Completed demand cannot launch");
    const guest = await this.#connect();
    this.#listener = new ListenerTransport(guest, this.#journal);
    await this.#listener.launch(request.jitConfig);
    return this.#reply();
  }
  async status() {
    ListenerTransport.observe(this.#journal);
    await this.#refreshVeto();
    const state = this.#journal.snapshot();
    if (state.active?.disposalProof?.interruptedUnassigned) {
      const guest = new GuestBoundary(state, state.active.name);
      await new IdleBoundary(guest, this.#journal, this.#listener).disposalInventory();
    } else if (IdleBoundary.recovering(state.active)) {
      await new IdleBoundary(await this.#connect(), this.#journal, this.#listener).resume();
    }
    return this.#reply();
  }
  async capture() {
    const active = this.#journal.snapshot().active;
    assert.ok(active?.jitSent);
    ListenerTransport.observe(this.#journal);
    if (active.veto || active.windowClosed) {
      return await this.status();
    }
    const observation = (await this.#connect()).capture();
    if (observation.veto) {
      this.#veto(observation);
      return this.#reply();
    }
    if (observation.windowClosed) {
      this.#journal.updateActive({ windowClosed: true });
      return this.#reply();
    }
    if (observation.pending) {
      return { ...this.#reply(), pending: true };
    }
    const capture = guardedCapture(observation, active);
    if (active.capture) {
      assert.deepEqual(capture, active.capture, "Replay or changed first context rejected");
    } else {
      this.#journal.updateActive({ capture });
      this.#journal.receipt("guarded-source-capture", capture);
    }
    return this.#reply();
  }
  #veto(observation) {
    const code = observation.code === "native-listener" ? "debugger" : "integrity";
    const receiptHash = digest(JSON.stringify(observation));
    this.#journal.receipt("prejob-guard-veto", observation);
    this.#journal.updateActive({
      windowClosed: true,
      veto: {
        code,
        receiptHash,
        hookFailed: false,
        noAck: observation.noAck === true,
        windowClosed: true,
      },
      vetoHookVerified: observation.hookVerified === true,
    });
  }
  async #refreshVeto() {
    const active = this.#journal.snapshot().active;
    if (!active?.veto || !active.vetoHookVerified || active.veto.hookFailed) {
      return;
    }
    const status = (await this.#connect()).vetoStatus();
    this.#journal.updateActive({ veto: { ...active.veto, ...status } });
  }
  async bind(request) {
    const active = this.#journal.snapshot().active;
    assert.ok(active?.capture && !active.veto);
    if (active.acked) {
      assert.deepEqual(request.binding, active.binding);
      return this.#reply();
    }
    assert.ok(!active.windowClosed, "Late source binding rejected");
    if (active.binding) {
      assert.deepEqual(request.binding, active.binding, "Frozen binding cannot change on replay");
    }
    const binding = freezeBinding(request.binding, active.capture);
    assert.equal(binding.runnerId, active.runnerId);
    this.#journal.updateActive({ binding, phase: "binding" });
    this.#journal.receipt("frozen-assigned-source", binding);
    const result = (await this.#connect()).acknowledge(active.nonce);
    if (result.veto) {
      this.#veto(result);
      return this.#reply();
    }
    assert.equal(result.acked, true, "Exited/replayed hook cannot receive ACK");
    this.#journal.updateActive({ acked: true, windowClosed: true, phase: "bound" });
    return this.#reply();
  }
  async drain(request) {
    IdleBoundary.beginDrain(request.terminal, this.#journal);
    const guest = await this.#connect();
    await new IdleBoundary(guest, this.#journal, this.#listener).drain(request.terminal);
    return this.#reply();
  }
  async settle(request) {
    const active = this.#journal.snapshot().active;
    assert.ok(active);
    if (active.disposalProof) {
      if (active.disposalProof.interruptedUnassigned) {
        IdleBoundary.disposal(active);
        assert.deepEqual(request.terminal, active.disposalProof.terminal);
      } else {
        assert.notEqual(request.terminal?.interruptedUnassigned, true);
      }
      return await this.#dispose();
    }
    if (this.#listener) {
      await this.#listener.join();
    }
    if (!active.jitSent) {
      await this.#unlaunched(request);
      return await this.#dispose();
    }
    ListenerTransport.observe(this.#journal);
    assert.equal(this.#journal.snapshot().active.transportEnded, true);
    if (request.terminal?.interruptedUnassigned === true) {
      IdleBoundary.terminal(request.terminal, active);
    } else {
      terminalIdentity(request.terminal, active);
    }
    const guest = await this.#connect();
    guest.listenerAbsent();
    const proof = await this.#assignedProof(request);
    const quiet = await guest.settled();
    this.#journal.receipt("quiescence", quiet);
    this.#journal.receipt("bounded-private-log-transfer", guest.logs());
    this.#journal.updateActive({
      phase: "stopping",
      disposalProof: { ...proof, quiet, terminal: request.terminal },
    });
    return await this.#dispose();
  }
  async #unlaunched(request) {
    if (this.#listener) {
      await this.#listener.join();
    }
    ListenerTransport.observe(this.#journal);
    const active = this.#journal.snapshot().active;
    if (active.listenerTransportPid) {
      assert.equal(active.transportEnded, true);
    }
    if (active.runnerId > 0) {
      assert.equal(
        request.terminal?.registrationAbsent,
        true,
        "SDK registration must be proved absent before native disposal",
      );
    }
    const state = this.#journal.snapshot(),
      guest = new GuestBoundary(state, active.name);
    const inventory = guest.status();
    let quiet;
    if (inventory === "running") {
      await guest.connect();
      assert.ok(
        active.cut || !active.ciStarted,
        "Interrupted foundation work cannot admit survivors",
      );
      quiet = await guest.settled(!active.ciStarted);
    } else {
      assert.ok(!active.ciStarted && ["stopped", "absent"].includes(inventory));
    }
    this.#journal.updateActive({
      phase: "stopping",
      disposalProof: { noCredentialsSent: true, quiet, inventory },
    });
  }
  async #assignedProof(request) {
    if (request.terminal.interruptedUnassigned === true) {
      return await new IdleBoundary(this.#guest, this.#journal, this.#listener).settleInterrupted(
        request.terminal,
      );
    }
    if (request.terminal.noJob) {
      return IdleBoundary.canceledProof(request.terminal, this.#journal.snapshot().active);
    }
    if (request.terminal.vetoed) {
      return await this.#vetoProof(request.terminal);
    }
    return this.#sourceProof(request);
  }
  async #vetoProof(terminal) {
    await this.#refreshVeto();
    const active = this.#journal.snapshot().active,
      veto = active.veto;
    assert.ok(veto?.hookFailed && veto.noAck && veto.windowClosed && !active.acked);
    assert.ok(terminal.conclusion && terminal.conclusion !== "success");
    assert.equal(terminal.requestId, active.completion?.runnerRequestId);
    assert.equal(terminal.runId, active.completion?.workflowRunId);
    this.#journal.receipt("vetoed-terminal", { terminal, veto });
    return { sourceVerified: false, vetoVerified: true };
  }
  #sourceProof(request) {
    const active = this.#journal.snapshot().active,
      terminal = request.terminal;
    assert.ok(active.acked && active.binding && !active.veto);
    assert.deepEqual(request.binding, active.binding);
    for (const key of ["runId", "attempt", "jobId", "runnerId", "runnerName"]) {
      assert.equal(terminal[key], active.binding[key]);
    }
    assert.ok(terminal.conclusion);
    const files = this.#guest.sourceFiles(checkoutManifest(active.binding));
    assert.equal(files.consistent, true);
    assert.equal(files.files, active.binding.files.length);
    this.#journal.receipt("root-checkout-consistency", files);
    return { sourceVerified: true, vetoVerified: false };
  }
  async #dispose() {
    const state = this.#journal.snapshot(),
      active = state.active;
    const guest = new GuestBoundary(state, active.name);
    assert.ok(active.disposalProof);
    const inventory = active.disposalProof.interruptedUnassigned
      ? await new IdleBoundary(guest, this.#journal, this.#listener).disposalInventory()
      : guest.status();
    if (inventory === "running") {
      if (!active.disposalProof.interruptedUnassigned) {
        await guest.connect();
        this.#journal.receipt("resumed-native-settlement", await guest.settled(!active.ciStarted));
      }
      this.#journal.updateActive({ phase: "stopping" });
      guest.stop();
    } else {
      assert.ok(["stopped", "absent"].includes(inventory));
    }
    this.#journal.updateActive({ phase: "deleting" });
    if (guest.status() === "stopped") {
      guest.delete();
    }
    assert.equal(guest.status(), "absent");
    const result = {
      phase: "disposed",
      disposed: true,
      transportEnded: true,
      sourceVerified: active.disposalProof.sourceVerified === true,
      vetoVerified: active.disposalProof.vetoVerified === true,
      interruptedUnassigned: active.disposalProof.interruptedUnassigned === true,
    };
    this.#journal.disposed(result);
    return result;
  }
  #reply() {
    const active = this.#journal.snapshot().active;
    if (!active) {
      return { phase: "absent" };
    }
    if (active.interruptedUnassigned) {
      IdleBoundary.interrupted(active);
    }
    return {
      phase: active.phase,
      prepared: active.prepared === true,
      launched: active.jitSent === true,
      transportEnded: active.transportEnded === true,
      interruptedUnassigned: active.interruptedUnassigned === true,
      capture: active.capture,
      veto: active.veto,
      pending: !active.capture && !active.windowClosed,
    };
  }
  async close() {
    let failure, guest;
    try {
      const active = this.#journal.snapshot().active;
      if (active) {
        this.#journal.updateActive({ operatorEOF: true, windowClosed: true });
        if (active.disposalProof?.interruptedUnassigned) {
          const state = this.#journal.snapshot();
          const ownedGuest = new GuestBoundary(state, active.name);
          await new IdleBoundary(ownedGuest, this.#journal, this.#listener).disposalInventory();
        } else if (active.jitSent && !active.acked) {
          guest = await this.#connect();
        }
      }
    } catch (error) {
      failure = error;
    }
    await new IdleBoundary(guest, this.#journal, this.#listener).close(failure);
  }
  failure(error) {
    this.#journal.recordFailure(error);
  }
}
