import type net from "net";
import { randomUUID } from "crypto";
import type { Message, SessionInfo } from "../types.ts";
import { nativePeerId } from "../session-targets.ts";
import { isRecord, type UnknownRecord } from "../../shared/unknown.ts";
import type { WakeResult } from "../../shared/parking.ts";
import { validateIntercomMessageSize, writeMessage } from "./framing.ts";

type Retained = Array<{
  readonly from: SessionInfo;
  readonly sender: net.Socket | undefined;
  readonly message: Message;
}>;
interface WakeAttempt {
  readonly id: string;
  readonly owner: net.Socket;
  readonly count: number;
  retry: boolean;
}
interface Parked {
  readonly retained: Retained;
  /** The fenced actor's socket closed: input waits for its restored replacement. */
  closed: boolean;
  attempt?: WakeAttempt;
  lastFailure?: string;
}
export interface ParkablePeer {
  readonly socket: net.Socket;
  readonly info: SessionInfo;
  /** This client can park itself, or wake and answer for its parked children. */
  readonly parking: boolean;
  readonly wakeResults: boolean;
  readonly wakeNotices: boolean;
  parked?: Parked;
}
export function reachable<T extends ParkablePeer>(target?: T): target is T {
  const socket = target?.socket;
  return socket !== undefined && !socket.destroyed && socket.writable && !socket.writableEnded;
}
type Deliver = (id: string, from: SessionInfo, message: Message) => string | null;
function requested(id: unknown): string | undefined {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : undefined;
}
function wakeResponse(msg: UnknownRecord): { id: string; result: WakeResult } {
  if (typeof msg.requestId === "string" && isRecord(msg.result)) {
    if (msg.result.status === "requested") {
      return { id: msg.requestId, result: { status: "requested" } };
    }
    if (msg.result.status === "failed" && typeof msg.result.reason === "string") {
      return { id: msg.requestId, result: { status: "failed", reason: msg.result.reason } };
    }
  }
  throw new Error("Invalid wake response");
}

/** A fenced child keeps its identity and queued input; it never departs while parked. */
export class ParkedSessions<T extends ParkablePeer> {
  private readonly sessions: ReadonlyMap<string, T>;
  private readonly deliver: Deliver;
  constructor(sessions: ReadonlyMap<string, T>, deliver: Deliver) {
    this.sessions = sessions;
    this.deliver = deliver;
  }
  handle(socket: net.Socket, id: string, msg: UnknownRecord): boolean {
    if (msg.type === "park" || msg.type === "unpark") {
      this.park(socket, id, msg.type === "park");
      return true;
    }
    if (msg.type === "wake_result") {
      const owner = this.sessions.get(id);
      if (owner) {
        this.respond(owner, msg);
      }
      return true;
    }
    return false;
  }
  private park(socket: net.Socket, id: string, on: boolean): void {
    const session = this.sessions.get(id);
    if (on && session?.parking === true) {
      session.parked ??= { retained: [], closed: false };
      // Frames already written to this socket precede the acknowledgement.
      writeMessage(socket, { type: "parked" });
    } else if (!on && session?.parked?.closed === false) {
      const { retained } = session.parked;
      session.parked = undefined;
      this.flush(id, retained);
    }
  }
  /**
   * Delivers retained input in order. A transport that fails mid-flush keeps the rest for its
   * next generation; delivery refusals on a live transport follow resident delivery.
   */
  private flush(id: string, retained: Retained): void {
    for (const [index, { from, message }] of retained.entries()) {
      const session = this.sessions.get(id);
      if (this.deliver(id, from, message) !== null && session?.socket.writable === false) {
        session.parked = { retained: retained.slice(index), closed: false };
        return;
      }
    }
  }
  /** A free requested identity, or a parked one resumed by the same child lineage. */
  claim(requestedId: unknown, next: Omit<SessionInfo, "id">): { id: string; resumed?: T } {
    const id = requested(requestedId);
    const previous = id === undefined ? undefined : this.sessions.get(id);
    const resumes =
      previous?.parked !== undefined &&
      previous.info.rootSessionId === next.rootSessionId &&
      previous.info.parentSessionId === next.parentSessionId;
    if (id === undefined || (previous && !resumes)) {
      return { id: randomUUID() };
    }
    previous?.socket.destroy();
    return { id, resumed: previous };
  }
  /** Flushes a restored child's input and re-sends wakes owed to a (re)registered main. */
  registered(id: string, previous?: T): void {
    this.registeredWake(previous);
    this.flush(id, previous?.parked?.retained ?? []);
    for (const child of this.sessions.values()) {
      if (nativePeerId(child.info.rootSessionId ?? "") === id) {
        this.wake(child);
      }
    }
  }
  private registeredWake(previous?: T): void {
    const main = previous && this.main(previous);
    const attempt = previous?.parked?.attempt;
    if (reachable(main) && attempt?.owner === main.socket) {
      writeMessage(main.socket, { type: "wake_registered", requestId: attempt.id });
    }
  }
  capabilities(msg: UnknownRecord): { wakeResults?: 1; wakeNotices?: 1 } {
    return {
      ...(msg.wakeResults === 1 ? { wakeResults: 1 } : {}),
      ...(msg.wakeNotices === 1 ? { wakeNotices: 1 } : {}),
    };
  }
  features(msg: UnknownRecord): Pick<ParkablePeer, "parking" | "wakeResults" | "wakeNotices"> {
    return {
      parking: msg.parking === true,
      wakeResults: msg.wakeResults === 1,
      wakeNotices: msg.wakeNotices === 1,
    };
  }
  /** A transport handoff, not a departure: no session_left and queued input stays. */
  closed(session: T): boolean {
    const { parked } = session;
    if (parked) {
      parked.closed = true;
      this.wake(session);
    }
    return parked !== undefined;
  }
  /**
   * Exited parked children keep identities while some live session remains. Input already
   * admitted for one keeps the broker until a returning main wakes it.
   */
  get exited(): boolean {
    return [...this.sessions.values()].every(
      ({ parked }) => parked?.closed === true && parked.retained.length === 0,
    );
  }
  retain(target: T | undefined, from: SessionInfo, message: Message): boolean {
    target?.parked?.retained.push({ from, message, sender: this.sessions.get(from.id)?.socket });
    if (target && this.waking(message)) {
      this.wake(target);
    }
    return target?.parked !== undefined;
  }
  queueReason(target: T | undefined, messageId: string): string {
    const last = target?.parked?.lastFailure;
    const reason =
      last === undefined
        ? "Queued for a parked child; delivery awaits its return."
        : `Queued for a parked child; the last wake failed: ${last} The message may still arrive after a later wake.`;
    return validateIntercomMessageSize({ type: "delivery_queued", messageId, reason }) === null
      ? reason
      : "Queued for a parked child; its last wake failed. Inspect the agent run for details.";
  }
  /** Reads of an exited parked child go to its main, which answers from captured history. */
  reader(id: string): T | undefined {
    const child = this.sessions.get(id);
    return child?.parked?.closed === true ? this.main(child) : undefined;
  }
  // Passive breadcrumbs and topic updates wait for a genuine wake; they never spawn the child.
  private wake(child: T): void {
    const main = this.main(child);
    const parked = child.parked;
    if (
      !reachable(main) ||
      parked?.closed !== true ||
      !parked.retained.some(({ message }) => this.waking(message))
    ) {
      return;
    }
    if (!main.wakeResults) {
      writeMessage(main.socket, { type: "wake", sessionId: child.info.id });
      return;
    }
    if (parked.attempt?.owner === main.socket) {
      parked.attempt.retry = true;
      return;
    }
    const attempt = {
      id: randomUUID(),
      owner: main.socket,
      count: parked.retained.length,
      retry: false,
    };
    parked.attempt = attempt;
    writeMessage(main.socket, { type: "wake", sessionId: child.info.id, requestId: attempt.id });
  }
  private waking(message: Message): boolean {
    return (
      message.passive !== true && message.delivery !== "passive" && message.topic === undefined
    );
  }
  /** Only the main sent this request can report it, and only while that child stays parked. */
  private respond(owner: T, msg: UnknownRecord): void {
    const { id, result } = wakeResponse(msg);
    const child = [...this.sessions.values()].find(
      (peer) =>
        peer.parked?.attempt?.id === id &&
        peer.parked.attempt.owner === owner.socket &&
        this.main(peer) === owner,
    );
    const parked = child?.parked;
    const attempt = parked?.attempt;
    if (!child || !parked || !attempt) {
      return;
    }
    parked.attempt = undefined;
    if (result.status === "failed") {
      parked.lastFailure = result.reason;
      for (const retained of parked.retained.slice(0, attempt.count)) {
        this.notify(child, retained, result.reason);
      }
    }
    if (attempt.retry) {
      this.wake(child);
    }
  }
  private notify(child: T, { from, sender, message }: Retained[number], reason: string): void {
    const origin = this.sessions.get(from.id);
    if (
      message.expectsReply !== true ||
      origin?.wakeNotices !== true ||
      origin.socket !== sender ||
      !reachable(origin)
    ) {
      return;
    }
    const frame = {
      type: "wake_failed",
      sessionId: child.info.id,
      messageId: message.id,
      reason,
    };
    writeMessage(
      origin.socket,
      validateIntercomMessageSize(frame) === null
        ? frame
        : { ...frame, reason: "Wake failed; inspect the agent run for details." },
    );
  }
  private main(child: T): T | undefined {
    const main = this.sessions.get(nativePeerId(child.info.rootSessionId ?? ""));
    return main?.parking === true && main.parked === undefined ? main : undefined;
  }
}
