import type net from "node:net";
import { writeMessage } from "./framing.ts";

/** Parking negotiation and its single outstanding broker acknowledgement. */
export class ParkRequests {
  supported = false;
  private acknowledged?: ((parked: boolean) => void) | undefined;
  settle(parked: boolean): void {
    this.acknowledged?.(parked);
  }
  /** True once the broker retains later input; false when it cannot or the socket closed. */
  request(socket: () => net.Socket, on: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      this.acknowledged = on && this.supported ? resolve : undefined;
      if (this.supported) {
        writeMessage(socket(), { type: on ? "park" : "unpark" });
      }
      if (this.acknowledged === undefined) {
        resolve(false);
      }
    });
  }
}
