import type net from "node:net";
import { writeMessage } from "./framing.ts";

/** Parking negotiation and its single outstanding broker acknowledgement. */
export class ParkRequests {
  private state:
    | { readonly kind: "idle" }
    | {
        readonly kind: "pending";
        readonly promise: Promise<boolean>;
        readonly resolve: (parked: boolean) => void;
      } = { kind: "idle" };
  settle(parked: boolean): void {
    const state = this.state;
    this.state = { kind: "idle" };
    if (state.kind === "pending") {
      state.resolve(parked);
    }
  }
  /** True once the broker retains later input; false when it cannot or the socket closed. */
  request(socket: () => net.Socket, on: boolean, supported: boolean): Promise<boolean> {
    if (on && this.state.kind === "pending") {
      return this.state.promise;
    }
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    this.settle(false);
    if (on && supported) {
      this.state = { kind: "pending", promise, resolve };
    }
    try {
      if (supported) {
        writeMessage(socket(), { type: on ? "park" : "unpark" });
      }
      if (this.state.kind === "idle") {
        resolve(false);
      }
    } catch (error) {
      this.state = { kind: "idle" };
      reject(error);
    }
    return promise;
  }
}
