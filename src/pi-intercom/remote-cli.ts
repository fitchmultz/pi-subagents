import { hash, randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { IntercomClient } from "./broker/client.ts";
import { getBrokerSocketPath, isOwnedBrokerSocket } from "./broker/paths.ts";
import { isDeviceAlias } from "./config.ts";
import { resolveConnectedTarget, resolvePeerHealth } from "./connected-target.ts";
import { ReplyWait } from "./reply-wait.ts";
import {
  AskDeliveryError,
  RecoveryError,
  sendErrorFacts,
  type SendProgress,
} from "./tool-results.ts";
import {
  isMessage,
  type Message,
  type SendOptions,
  type SendResult,
  type SessionInfo,
} from "./types.ts";
import { safeLabel } from "./validation.ts";
import { errorMessage, hasErrorCode, isRecord } from "../shared/unknown.ts";

export interface RemoteRequest {
  readonly version: 1;
  readonly command: string;
  readonly origin: string;
}
export interface RemoteMessage extends RemoteRequest {
  readonly command: "send" | "ask";
  readonly device: string;
  readonly from: { readonly id: string; readonly name: string; readonly cwd: string };
  readonly to: string;
  readonly message: SendOptions;
  readonly timeoutMs: number;
}
export type RemoteSession = Pick<
  SessionInfo,
  | "id"
  | "name"
  | "cwd"
  | "model"
  | "projectId"
  | "status"
  | "startedAt"
  | "lastSeen"
  | "lastIntercomActivity"
  | "pendingAsks"
  | "acceptsAsks"
  | "lastTurnError"
>;
export type RemoteReply =
  | {
      readonly version: 1;
      readonly now: number;
      readonly sessions: readonly RemoteSession[];
    }
  | { readonly version: 1; readonly receipt: SendResult; readonly reply?: Message }
  | {
      readonly version: 1;
      readonly error: string;
      readonly code?: string;
      readonly deliveryUnknown?: true;
      readonly receipt?: SendResult;
    };

const REMOTE_ID_PREFIX = "remote-";
const COMMAND_MODEL = "remote-cli";
const HEARTBEAT_MS = 1000;

async function joinBroker(
  session: { readonly name: string; readonly cwd: string },
  id: string,
): Promise<IntercomClient | undefined> {
  if (!isOwnedBrokerSocket(getBrokerSocketPath())) {
    return undefined;
  }
  const client = new IntercomClient();
  client.on("error", () => {
    // The pending request rejects with the same failure.
  });
  try {
    await client.connect({ ...session, model: COMMAND_MODEL }, id);
    if (client.sessionId !== id) {
      throw new Error(
        "This remote sender already has a command connected; wait for it to finish before sending another command.",
      );
    }
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
    startedAt: session.startedAt,
    lastSeen: session.lastSeen,
    lastIntercomActivity: session.lastIntercomActivity,
    pendingAsks: session.pendingAsks,
    acceptsAsks: session.acceptsAsks,
    lastTurnError: session.lastTurnError,
  };
}

type Input = Readonly<Record<string, unknown>>;

function print(reply: RemoteReply): void {
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

async function list(request: RemoteRequest): Promise<RemoteReply> {
  const client = await joinBroker(
    { name: `intercom-list@${request.origin}`, cwd: process.cwd() },
    `${REMOTE_ID_PREFIX}${randomUUID()}`,
  );
  if (client === undefined) {
    return { version: 1, now: Date.now(), sessions: [] };
  }
  try {
    const sessions = await client.listSessions();
    return {
      version: 1,
      now: Date.now(),
      sessions: sessions
        .filter(
          ({ id, model }) =>
            id !== client.sessionId && !id.startsWith(REMOTE_ID_PREFIX) && model !== COMMAND_MODEL,
        )
        .map(listed),
    };
  } finally {
    await client.disconnect();
  }
}

function sendOptions(value: unknown, expectsReply: boolean): SendOptions {
  const message = isRecord(value)
    ? {
        id: value.messageId,
        timestamp: 0,
        expectsReply,
        replyTo: value.replyTo,
        delivery: value.delivery,
        queueMode: value.queueMode,
        threadId: value.threadId,
        passive: value.passive,
        content: { text: value.text, attachments: value.attachments },
      }
    : undefined;
  if (!isMessage(message)) {
    throw new Error("Invalid message format");
  }
  const { id, timestamp: _clock, content, ...options } = message;
  return { ...options, ...content, messageId: id };
}

function senderOf(from: unknown): RemoteMessage["from"] | undefined {
  if (!isRecord(from)) {
    return undefined;
  }
  const { id, name, cwd } = from;
  return typeof id === "string" &&
    typeof name === "string" &&
    typeof cwd === "string" &&
    safeLabel(name) &&
    safeLabel(cwd)
    ? { id, name, cwd }
    : undefined;
}

function parseMessage(request: RemoteRequest, input: Input): RemoteMessage {
  const { device, to, timeoutMs } = input;
  const from = senderOf(input.from);
  const ask = request.command === "ask";
  if (
    !isDeviceAlias(device) ||
    from === undefined ||
    typeof to !== "string" ||
    typeof timeoutMs !== "number"
  ) {
    throw new Error("Expected a device, a sender, a target and a message.");
  }
  return {
    ...request,
    command: ask ? "ask" : "send",
    device,
    from,
    to,
    message: sendOptions(input.message, ask),
    timeoutMs,
  };
}

// Over SSH, only writing to stdout detects a closed caller pipe.
function callerGone(): AbortSignal {
  const gone = new AbortController();
  process.stdout.on("error", () => {
    gone.abort();
  });
  setInterval(() => process.stdout.write("\n"), HEARTBEAT_MS).unref();
  return gone.signal;
}

interface Dispatch {
  readonly client: IntercomClient;
  readonly request: RemoteMessage;
  readonly peer: string | null;
  readonly track: (progress: SendProgress) => void;
}

async function askHere({ client, request, peer, track }: Dispatch): Promise<RemoteReply> {
  const { message } = request;
  const shown = `${request.to}@${request.device}`;
  if (peer === null) {
    throw new Error(`Ask to "${shown}" was not sent: connected session not found.`);
  }
  const health = await resolvePeerHealth(client, peer);
  if (health?.acceptsAsks === false && message.delivery === undefined) {
    // A local asker stays connected for a later reply. This command cannot.
    throw new Error(
      `Ask to "${shown}" was not sent: the peer is busy and not accepting blocking asks (peer_busy). Use send, or ask with delivery "steer" to reach it at its next tool boundary and wait.`,
    );
  }
  const wait = new ReplyWait(
    {
      markActivity: () => {
        // A command has no presence to refresh.
      },
    },
    request.timeoutMs,
  );
  client.on("message", (from: SessionInfo, reply: Message) => {
    wait.receive(from, reply, () => {
      // Nothing is journaled here: the caller records the reply.
    });
  });
  client.on("session_left", (id: string) => {
    wait.peerDisconnected(id);
  });
  client.on("disconnected", (error: Readonly<Error>) => {
    wait.reject(new Error(`Disconnected while waiting for reply: ${error.message}`));
  });
  let receipt: SendResult | undefined;
  const reply = await wait.transact(client, {
    to: peer,
    questionId: message.messageId ?? "",
    options: message,
    signal: callerGone(),
    onSending: () => {
      track({ kind: "unconfirmed" });
    },
    onSent: (result) => {
      receipt = result;
      track({ kind: "acknowledged", result });
      // The caller learns of the delivery now. A connection that is lost during the wait
      // then costs the reply, not the knowledge that the question arrived.
      print({ version: 1, receipt: result });
    },
  });
  if (receipt === undefined) {
    throw new Error("The reply arrived without a receipt.");
  }
  return { version: 1, receipt, reply };
}

async function sendHere({ client, request, peer, track }: Dispatch): Promise<RemoteReply> {
  track({ kind: "unconfirmed" });
  return { version: 1, receipt: await client.send(peer ?? request.to, request.message) };
}

function failed(error: unknown, progress: SendProgress, words: string): RemoteReply {
  if (error instanceof AskDeliveryError) {
    return { version: 1, receipt: error.result };
  }
  return {
    version: 1,
    error: words,
    ...(error instanceof RecoveryError ? { code: error.code } : {}),
    ...(sendErrorFacts(error, progress).deliveryUnknown ? { deliveryUnknown: true } : {}),
    ...(progress.kind === "acknowledged" ? { receipt: progress.result } : {}),
  };
}

// Stable sender identity lets later replace-mode messages supersede earlier ones on the same thread.
async function deliver(base: RemoteRequest, input: Input): Promise<RemoteReply> {
  const request = parseMessage(base, input);
  const { origin, device, from, to } = request;
  const identity = hash("sha256", `${origin}\0${from.id}`, "hex").slice(0, 32);
  const client = await joinBroker(
    { name: `${from.name}@${origin}`, cwd: from.cwd },
    `${REMOTE_ID_PREFIX}${identity}`,
  );
  if (client === undefined) {
    return { version: 1, error: `Not sent to ${device}: no Pi session is connected there` };
  }
  let progress: SendProgress = { kind: "not-sent" };
  const track = (next: SendProgress) => {
    progress = next;
  };
  let peer: string | null = null;
  try {
    peer = await resolveConnectedTarget(client, to, `@${device}`);
    return await (request.command === "ask" ? askHere : sendHere)({ client, request, peer, track });
  } catch (error) {
    const words = errorMessage(error);
    // A wait names its peer by the ID it has here. The caller knows it as `to@device`.
    return failed(
      error,
      progress,
      peer === null ? words : words.replaceAll(peer, `${to}@${device}`),
    );
  } finally {
    await client.disconnect();
  }
}

const commands: ReadonlyMap<
  string,
  (request: RemoteRequest, input: Input) => Promise<RemoteReply>
> = new Map([
  ["list", list],
  ["send", deliver],
  ["ask", deliver],
]);

function parseRequest(input: string): { readonly request: RemoteRequest; readonly body: Input } {
  const body: unknown = JSON.parse(input);
  if (
    !isRecord(body) ||
    body.version !== 1 ||
    typeof body.command !== "string" ||
    !isDeviceAlias(body.origin)
  ) {
    throw new Error("Expected a version 1 request with a command and an origin device.");
  }
  return { request: { version: 1, command: body.command, origin: body.origin }, body };
}

async function answer(input: string): Promise<RemoteReply> {
  try {
    const { request, body } = parseRequest(input);
    const command = commands.get(request.command);
    return command === undefined
      ? { version: 1, error: `Unsupported command ${JSON.stringify(request.command)}.` }
      : await command(request, body);
  } catch (error) {
    return { version: 1, error: errorMessage(error) };
  }
}

process.stdout.on("error", () => {
  // The caller is gone; nobody reads the reply.
});
const reply = await answer(await text(process.stdin));
print(reply);
process.exitCode = "error" in reply ? 1 : 0;
