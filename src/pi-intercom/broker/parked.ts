import type net from "net";
import { randomUUID } from "crypto";
import type { Message, SessionInfo } from "../types.ts";
import { nativePeerId } from "../session-targets.ts";
import { writeMessage } from "./framing.ts";

type Retained = Array<{ readonly from: SessionInfo; readonly message: Message }>;
interface Parked {
  readonly retained: Retained;
  /** The fenced actor's socket closed: input waits for its restored replacement. */
  closed: boolean;
}
export interface ParkablePeer {
  readonly socket: net.Socket;
  readonly info: SessionInfo;
  /** This client can park itself, or wake and answer for its parked children. */
  readonly parking: boolean;
  parked?: Parked;
}
type Deliver = (id: string, from: SessionInfo, message: Message) => string | null;
function requested(id: unknown): string | undefined {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : undefined;
}

/** A fenced child keeps its identity and queued input; it never departs while parked. */
export class ParkedSessions<T extends ParkablePeer> {
  private readonly sessions: ReadonlyMap<string, T>;
  private readonly deliver: Deliver;
  constructor(sessions: ReadonlyMap<string, T>, deliver: Deliver) {
    this.sessions = sessions;
    this.deliver = deliver;
  }
  park(socket: net.Socket, id: string, on: boolean): void {
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
    this.flush(id, previous?.parked?.retained ?? []);
    for (const child of this.sessions.values()) {
      if (nativePeerId(child.info.rootSessionId ?? "") === id) {
        this.wake(child);
      }
    }
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
    target?.parked?.retained.push({ from, message });
    if (target) {
      this.wake(target);
    }
    return target?.parked !== undefined;
  }
  /** Reads of an exited parked child go to its main, which answers from captured history. */
  reader(id: string): T | undefined {
    const child = this.sessions.get(id);
    return child?.parked?.closed === true ? this.main(child) : undefined;
  }
  // Passive breadcrumbs and topic updates wait for a genuine wake; they never spawn the child.
  private wake(child: T): void {
    const main = this.main(child);
    const wakes = child.parked?.retained.some(
      ({ message }) =>
        message.passive !== true && message.delivery !== "passive" && message.topic === undefined,
    );
    if (main && child.parked?.closed === true && wakes === true) {
      writeMessage(main.socket, { type: "wake", sessionId: child.info.id });
    }
  }
  private main(child: T): T | undefined {
    const main = this.sessions.get(nativePeerId(child.info.rootSessionId ?? ""));
    return main?.parking === true && main.parked === undefined ? main : undefined;
  }
}
