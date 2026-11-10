/**
 * The command that another device of the same owner runs here over SSH.
 *
 * It reads one JSON request from stdin, prints one JSON reply line on stdout and exits: status 0
 * for a result, 1 for a reply with `error`. It joins this device's running broker as a
 * short-lived main. It never starts a broker: without one, no Pi session is open here.
 */
import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { IntercomClient } from "./broker/client.ts";
import { getBrokerSocketPath, isOwnedBrokerSocket } from "./broker/paths.ts";
import { isDeviceAlias } from "./config.ts";
import type { SessionInfo } from "./types.ts";
import { errorMessage, hasErrorCode, isRecord } from "../shared/unknown.ts";

export interface RemoteRequest {
  readonly version: 1;
  readonly command: string;
  /** The calling device's alias. */
  readonly origin: string;
}
/** A session of another device: the fields of a list row, nothing that identifies its context. */
export type RemoteSession = Pick<
  SessionInfo,
  | "id"
  | "name"
  | "cwd"
  | "model"
  | "projectId"
  | "status"
  | "lastSeen"
  | "lastIntercomActivity"
  | "pendingAsks"
  | "acceptsAsks"
>;
export type RemoteReply =
  | {
      readonly version: 1;
      /** This device's clock, so the caller prints ages without comparing two clocks. */
      readonly now: number;
      readonly sessions: readonly RemoteSession[];
    }
  | { readonly version: 1; readonly error: string };

/** Identities that are not Pi sessions of this device: bridge peers and commands like this one. */
const REMOTE_ID_PREFIX = "remote-";

/** Undefined when no broker runs here. */
async function joinBroker(name: string): Promise<IntercomClient | undefined> {
  if (!isOwnedBrokerSocket(getBrokerSocketPath())) {
    return undefined;
  }
  const client = new IntercomClient();
  client.on("error", () => {
    // The pending request rejects with the same failure.
  });
  try {
    await client.connect(
      { name, cwd: process.cwd(), model: "remote-cli" },
      `${REMOTE_ID_PREFIX}${randomUUID()}`,
    );
  } catch (error) {
    await client.disconnect();
    // A socket file without a listener is left by a broker that has exited.
    if (hasErrorCode(error, "ECONNREFUSED") || hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  return client;
}

function listed(session: SessionInfo): RemoteSession {
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    model: session.model,
    projectId: session.projectId,
    status: session.status,
    lastSeen: session.lastSeen,
    lastIntercomActivity: session.lastIntercomActivity,
    pendingAsks: session.pendingAsks,
    acceptsAsks: session.acceptsAsks,
  };
}

/** The Pi mains of this device. A client without lineage cannot see a child. */
async function list(request: RemoteRequest): Promise<RemoteReply> {
  const client = await joinBroker(`intercom-list@${request.origin}`);
  if (client === undefined) {
    return { version: 1, now: Date.now(), sessions: [] };
  }
  try {
    const sessions = await client.listSessions();
    return {
      version: 1,
      now: Date.now(),
      sessions: sessions
        .filter(({ id }) => id !== client.sessionId && !id.startsWith(REMOTE_ID_PREFIX))
        .map(listed),
    };
  } finally {
    await client.disconnect();
  }
}

const commands: ReadonlyMap<string, (request: RemoteRequest) => Promise<RemoteReply>> = new Map([
  ["list", list],
]);

function parseRequest(input: string): RemoteRequest {
  const request: unknown = JSON.parse(input);
  if (
    !isRecord(request) ||
    request.version !== 1 ||
    typeof request.command !== "string" ||
    !isDeviceAlias(request.origin)
  ) {
    throw new Error("Expected a version 1 request with a command and an origin device.");
  }
  return { version: 1, command: request.command, origin: request.origin };
}

async function answer(input: string): Promise<RemoteReply> {
  try {
    const request = parseRequest(input);
    const command = commands.get(request.command);
    return command === undefined
      ? { version: 1, error: `Unsupported command ${JSON.stringify(request.command)}.` }
      : await command(request);
  } catch (error) {
    return { version: 1, error: errorMessage(error) };
  }
}

const reply = await answer(await text(process.stdin));
process.stdout.write(`${JSON.stringify(reply)}\n`);
process.exitCode = "error" in reply ? 1 : 0;
