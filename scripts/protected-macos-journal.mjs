import assert from "node:assert/strict";
import { loadState, saveState, writeReceipt } from "./protected-macos-operator.mjs";

// Sole native journal writer, including asynchronous listener-return publication.
export class NativeJournal {
  #state;
  #path;
  constructor(path) {
    this.#path = path;
    this.#state = loadState(path);
  }
  snapshot() {
    return structuredClone(this.#state);
  }
  setActive(active) {
    this.#state.active = structuredClone(active);
    this.#save();
  }
  updateActive(patch) {
    assert.ok(this.#state.active, "No live native operation to update");
    this.#state.active = { ...this.#state.active, ...structuredClone(patch) };
    this.#save();
  }
  disposed(proof) {
    const active = this.#state.active;
    assert.ok(active?.disposalProof);
    this.#state.lastDisposed = {
      operationID: active.operationID,
      runnerName: active.runnerName,
      ...proof,
      ...(proof.interruptedUnassigned
        ? { interruptedTerminal: active.disposalProof.terminal }
        : {}),
    };
    this.#state.active = null;
    this.#save();
  }
  receipt(name, evidence) {
    writeReceipt(this.#state, name, evidence);
  }
  recordFailure(error) {
    this.receipt("operator-failure", {
      phase: this.#state.active?.phase,
      code: error.code,
      name: error.name,
      message: String(error.message).slice(0, 8192),
    });
  }
  #save() {
    saveState(this.#path, this.#state);
  }
}
