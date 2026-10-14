import { randomUUID } from "node:crypto";
import type { Message } from "./types.ts";
import { Fault, wait } from "./bridge-protocol.ts";
import type { IntercomClient } from "./broker/client.ts";
import type { TranscriptOptions } from "./transcript.ts";
import {
  CONTROL_FALLBACK,
  CONTROL_SCHEMA,
  isControlResult,
  type NativeControlResult,
  type NativeControlVerb,
} from "./native-control-protocol.ts";
import type { UnknownRecord } from "../shared/unknown.ts";

interface Pending {
  readonly peer: string;
  readonly verb: NativeControlVerb;
  readonly reply: Promise<NativeControlResult>;
  readonly resolve: (result: NativeControlResult) => void;
  readonly reject: (error: Readonly<Error>) => void;
  readonly timer: NodeJS.Timeout;
  disconnected: boolean;
}
/** One bounded request owner; exact socket-derived peer, replyTo, version and verb correlation. */
export class ControlReplies {
  private readonly pending = new Map<string, Pending>();
  private open(
    peer: string,
    verb: NativeControlVerb,
    timeoutMs: number,
  ): {
    readonly id: string;
    readonly reply: Promise<NativeControlResult>;
    readonly clear: () => void;
    readonly observedDisconnected: boolean;
  } {
    if (this.pending.size >= 8) {
      throw new Fault(429, "too_many_controls", "At most eight native controls may be in flight.");
    }
    const id = randomUUID();
    const { promise: reply, resolve, reject } = Promise.withResolvers<NativeControlResult>();
    // A disconnect may reject while send is awaiting its broker receipt.
    void reply.catch(() => {
      /* Request owner observes rejection after its send receipt. */
    });
    const timer = setTimeout(
      () =>
        reject(
          new Fault(
            504,
            "control_unconfirmed",
            "No correlated native response. Owner may be old/unavailable; execution is unknown. Do not automatically retry.",
            { id, deliveryUnknown: true },
          ),
        ),
      timeoutMs,
    );
    const pending = { peer, verb, reply, resolve, reject, timer, disconnected: false };
    this.pending.set(id, pending);
    return {
      id,
      reply,
      clear: () => this.clear(id),
      get observedDisconnected() {
        return pending.disconnected;
      },
    };
  }
  async request(
    client: Readonly<Pick<IntercomClient, "send">>,
    operation: {
      readonly peer: string;
      readonly verb: NativeControlVerb;
      readonly options?: TranscriptOptions;
      readonly certificate: string;
      readonly timeoutMs: number;
    },
    context: {
      readonly signal: AbortSignal;
      readonly guard: () => void;
      readonly onPeer: (peer: string) => void;
    },
  ): Promise<UnknownRecord> {
    context.onPeer(operation.peer);
    const waiting = this.open(operation.peer, operation.verb, operation.timeoutMs);
    try {
      context.guard();
      const receipt = await wait(
        client.send(operation.peer, {
          text: CONTROL_FALLBACK,
          messageId: waiting.id,
          delivery: "passive",
          control: {
            schema: CONTROL_SCHEMA,
            kind: "request",
            verb: operation.verb,
            certificate: operation.certificate,
            options: operation.options,
          },
        }),
        context.signal,
      ).catch((error: unknown) => {
        context.guard();
        if (error instanceof Fault) {
          throw error;
        }
        throw new Fault(
          504,
          "control_unconfirmed",
          "Broker receipt was not received; native execution is unknown. Do not automatically retry.",
          { id: waiting.id, deliveryUnknown: true },
        );
      });
      context.guard();
      if (!receipt.accepted) {
        throw new Fault(
          409,
          "delivery_failed",
          receipt.reason ?? "Broker rejected native control.",
          { id: receipt.id },
        );
      }
      const result = await wait(waiting.reply, context.signal);
      context.guard();
      return {
        ...receipt,
        peer: operation.peer,
        status: result.status,
        native: result,
        observedDisconnected: waiting.observedDisconnected,
        processExited: false,
      };
    } finally {
      waiting.clear();
    }
  }
  receive(peer: string, message: Message): boolean {
    if (!Object.hasOwn(message, "control")) {
      return false;
    }
    const pending = message.replyTo === undefined ? undefined : this.pending.get(message.replyTo);
    if (
      pending &&
      pending.peer === peer &&
      message.delivery === "passive" &&
      isControlResult(message.control) &&
      message.control.verb === pending.verb
    ) {
      pending.resolve(message.control);
    }
    // Unsolicited/spoofed/malformed control results do not enter the remote mailbox.
    return true;
  }
  peerLeft(peer: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.peer === peer) {
        pending.disconnected = true;
        pending.reject(
          new Fault(
            409,
            "peer_disconnected",
            "Native peer disconnected; this does not establish process exit.",
            { id, observedDisconnected: true, processExited: false, deliveryUnknown: true },
          ),
        );
      }
    }
  }
  close(error: Readonly<Error>): void {
    for (const [id, pending] of this.pending) {
      pending.reject(error);
      this.clear(id);
    }
  }
  private clear(id: string): void {
    clearTimeout(this.pending.get(id)?.timer);
    this.pending.delete(id);
  }
}
