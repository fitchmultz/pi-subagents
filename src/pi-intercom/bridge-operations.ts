import { join } from "node:path";
import { isRecord, type UnknownRecord } from "../shared/unknown.ts";
import type { Identity } from "./bridge-config.ts";
import type { RequestContext } from "./bridge-http.ts";
import type { Operation } from "./bridge-routes.ts";
import type { Session } from "./bridge-session.ts";
import { Launcher } from "./bridge-launch.ts";
import { SessionCatalog, savedView, trustedJournal } from "./bridge-catalog.ts";
import { Groups } from "./bridge-groups.ts";
import { broadcastTargets } from "./bridge-broadcast.ts";
import { getPiAgentDir } from "./agent-dir.ts";
import { Fault } from "./bridge-protocol.ts";
import { resolveBridgeTarget } from "./bridge-target.ts";
import { readSavedTranscript } from "./saved-transcript.ts";

type OperationContext = RequestContext & {
  readonly expires: number;
  readonly certificate: string;
};

/** Request operations own launch/catalog/group state; transport owns admission and cancellation. */
export class BridgeOperations {
  private readonly catalog = new SessionCatalog();
  private readonly launcher = new Launcher(this.catalog);
  private readonly stateDir: string;
  private groups?: Groups;

  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? join(getPiAgentDir(), "intercom", "bridge-state");
  }
  revoke(clients: ReadonlyMap<string, Identity>): Promise<void> {
    return this.launcher.revoke(clients);
  }
  shutdown(): Promise<void> {
    return this.launcher.shutdown();
  }
  private groupStore(): Groups {
    this.groups ??= new Groups(this.stateDir);
    return this.groups;
  }
  async execute(
    operation: Operation,
    session: Readonly<Session>,
    context: OperationContext,
  ): Promise<UnknownRecord> {
    const launchContext = {
      identity: session.identity,
      expires: context.expires,
      signal: context.signal,
      peers: (signal: AbortSignal) => session.connectedPeers(signal),
      submit: (peer: string, task: string) => session.send(peer, task, context),
    };
    switch (operation.route) {
      case "POST /v1/start":
        return this.launcher.start(operation.name, launchContext);
      case "POST /v1/spawn":
        return this.launcher.spawn(operation, launchContext);
      case "POST /v1/resume":
        return this.launcher.resume(operation, launchContext);
      case "GET /v1/sessions":
        return operation.query === undefined
          ? this.launcher.list(session.identity)
          : this.launcher.browse(operation.query, launchContext);
      case "POST /v1/stop":
      case "POST /v1/cancel":
        return this.stop(operation, session, context);
      case "GET /v1/groups":
        return { groups: this.groupStore().list(session.identity.fingerprint256) };
      case "POST /v1/groups":
        return {
          groups: this.groupStore().upsert(session.identity.fingerprint256, operation.group),
        };
      case "POST /v1/broadcast":
        return broadcastTargets(
          session,
          this.groupStore().targets(
            session.identity.fingerprint256,
            operation.group,
            await session.connectedPeers(context.signal),
          ),
          operation.message,
          context,
        );
      case "POST /v1/control":
        return session.nativeControl(operation, context.certificate, context);
      case "GET /v1/transcript":
        return this.transcript(operation, session, context);
      case "GET /v1/inbox":
      case "GET /v1/list":
      case "POST /v1/ack":
      case "POST /v1/ask":
      case "POST /v1/register":
      case "POST /v1/reply":
      case "POST /v1/send":
        return session.execute(operation, context);
    }
  }
  private async stop(
    operation: Extract<Operation, { readonly route: "POST /v1/stop" | "POST /v1/cancel" }>,
    session: Readonly<Session>,
    context: OperationContext,
  ): Promise<UnknownRecord> {
    const cancel = operation.route === "POST /v1/cancel";
    const control = {
      signal: context.signal,
      peers: (signal: AbortSignal) => session.connectedPeers(signal),
    };
    try {
      return cancel
        ? await this.launcher.cancel(session.identity, operation.sessionId, control)
        : await this.launcher.stop(session.identity, operation.sessionId, control);
    } catch (error) {
      // Only a pre-effect ownership miss may dispatch elsewhere; never retry an unknown outcome.
      if (!(error instanceof Fault) || error.code !== "unknown_session") {
        throw error;
      }
    }
    return session.nativeControl(
      { to: operation.sessionId, verb: cancel ? "cancel" : "stop", timeoutMs: operation.timeoutMs },
      context.certificate,
      context,
    );
  }
  private async transcript(
    operation: Extract<Operation, { readonly route: "GET /v1/transcript" }>,
    session: Readonly<Session>,
    context: OperationContext,
  ): Promise<UnknownRecord> {
    const peers = await session.connectedPeers(context.signal);
    try {
      const peer = resolveBridgeTarget(peers, operation.target, null);
      const result = await session.nativeControl(
        {
          to: peer.id,
          verb: "transcript",
          options: operation.options,
          timeoutMs: operation.timeoutMs,
        },
        context.certificate,
        context,
      );
      return {
        ...result,
        source: "live",
        transcript: isRecord(result.native) ? result.native.transcript : undefined,
      };
    } catch (error) {
      if (!(error instanceof Fault) || error.code !== "peer_offline") {
        throw error;
      }
    }
    const policy = session.identity.launch;
    if (!policy) {
      throw new Fault(403, "launch_disabled", "Saved transcripts require local resume policy.");
    }
    const saved = await this.catalog.resolve(policy, { target: operation.target }, context.signal);
    trustedJournal(policy, saved.sessionFile);
    const page = await readSavedTranscript(
      policy.packageRoot,
      saved.sessionFile,
      operation.options,
    );
    session.guard(context.signal);
    if (page.sessionId !== saved.sessionId) {
      throw new Fault(409, "session_changed", "Saved journal identity changed during reading.");
    }
    return { status: "ok", source: "saved", session: savedView(saved), transcript: page };
  }
}
