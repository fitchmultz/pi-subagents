import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IntercomLifecycle } from "./lifecycle.ts";
import type { IntercomConnection } from "./connection.ts";
import type { Message, SessionInfo } from "./types.ts";
import { authorizedControlPeer } from "./native-control-auth.ts";
import {
  CONTROL_FALLBACK,
  CONTROL_SCHEMA,
  isControlRequest,
  type NativeControlRequest,
  type NativeControlResult,
} from "./native-control-protocol.ts";
import { readLiveTranscript, transcriptOptions } from "./transcript.ts";

export class NativeControls {
  private readonly lifecycle: Readonly<Pick<IntercomLifecycle, "live" | "generation">>;
  private readonly connection: Readonly<Pick<IntercomConnection, "active">>;
  constructor(lifecycle: NativeControls["lifecycle"], connection: NativeControls["connection"]) {
    this.lifecycle = lifecycle;
    this.connection = connection;
  }
  private result(ctx: ExtensionContext, request: NativeControlRequest): NativeControlResult {
    const base = {
      schema: CONTROL_SCHEMA,
      kind: "result",
      verb: request.verb,
      mode: ctx.mode,
      idle: ctx.isIdle(),
      pendingInput: ctx.hasPendingMessages(),
      queueCleared: false,
      processExited: false,
    } satisfies Partial<NativeControlResult>;
    if (request.verb !== "transcript" && request.options !== undefined) {
      throw new Error("Only transcript accepts options.");
    }
    const stopSupport = stopCapability(ctx);
    switch (request.verb) {
      case "capabilities":
        return {
          ...base,
          status: "ok",
          stopSupport,
          verbs: ["capabilities", "cancel", "stop", "transcript"],
        };
      case "transcript":
        return {
          ...base,
          status: "ok",
          transcript: readLiveTranscript(ctx.sessionManager, transcriptOptions(request.options)),
        };
      case "cancel":
        return {
          ...base,
          status: "cancel_requested",
          reason: "Native current-operation abort; accepted queued input is not cleared.",
        };
      case "stop":
        return {
          ...base,
          status:
            ctx.mode === "print" || ctx.mode === "json" ? "unsupported" : "shutdown_requested",
          stopSupport,
          reason:
            "Native shutdown/current-operation abort requested, not process exit. Idle RPC is deferred until a native command/settlement; print/JSON/SDK have no guaranteed shutdown binding.",
        };
    }
  }
  async receive(ctx: ExtensionContext, from: SessionInfo, message: Message): Promise<boolean> {
    if (!Object.hasOwn(message, "control")) {
      return false;
    }
    // Even malformed/response envelopes never enter conversation journaling or inference.
    const request = message.control;
    if (
      !isControlRequest(request) ||
      message.replyTo !== undefined ||
      message.delivery !== "passive" ||
      message.expectsReply === true
    ) {
      return true;
    }
    const generation = this.lifecycle.generation;
    const active = this.connection.active;
    if (!active || !this.lifecycle.live(ctx, generation)) {
      return true;
    }
    const result = this.admit(ctx, from.id, request);
    // Receipt is acknowledged before shutdown can retire this socket/context.
    await active.send(from.id, {
      text: CONTROL_FALLBACK,
      delivery: "passive",
      replyTo: message.id,
      control: result,
    });
    this.apply(ctx, generation, { active, peer: from.id, request, result });
    return true;
  }
  private apply(
    ctx: ExtensionContext,
    generation: number,
    state: {
      readonly active: NonNullable<IntercomConnection["active"]>;
      readonly peer: string;
      readonly request: NativeControlRequest;
      readonly result: NativeControlResult;
    },
  ): void {
    const { active, peer, request, result } = state;
    if (
      !this.lifecycle.live(ctx, generation) ||
      this.connection.active !== active ||
      !authorizedControlPeer(peer, request.certificate)
    ) {
      return;
    }
    if (
      result.status === "shutdown_requested" ||
      (result.status === "unsupported" && request.verb === "stop")
    ) {
      ctx.shutdown();
      if (this.lifecycle.live(ctx, generation)) {
        ctx.abort();
      }
    } else if (result.status === "cancel_requested") {
      ctx.abort();
    }
  }
  private admit(
    ctx: ExtensionContext,
    peer: string,
    request: NativeControlRequest,
  ): NativeControlResult {
    if (!authorizedControlPeer(peer, request.certificate)) {
      return {
        schema: CONTROL_SCHEMA,
        kind: "result",
        verb: request.verb,
        status: "denied",
        reason: "Sender certificate is not currently authorized by private bridge configuration.",
      };
    }
    try {
      return this.result(ctx, request);
    } catch {
      return {
        schema: CONTROL_SCHEMA,
        kind: "result",
        verb: request.verb,
        status: "failed",
        reason: "Native control input/state is unavailable.",
      };
    }
  }
}
function stopCapability(ctx: ExtensionContext): NativeControlResult["stopSupport"] {
  if (ctx.mode === "tui") {
    return "native_shutdown";
  }
  return ctx.mode === "rpc" ? "requires_activity" : "host_dependent";
}
