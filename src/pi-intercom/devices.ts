import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SendError } from "./broker/client-send.ts";
import { MAX_FRAME_SIZE_BYTES } from "./broker/framing.ts";
import { intercomConfigPath, type IntercomConfig } from "./config.ts";
import type { RemoteMessage, RemoteRequest } from "./remote-cli.ts";
import { AskDeliveryError, RecoveryError } from "./tool-results.ts";
import type { IntercomTransport } from "./transport.ts";
import {
  normalizeMessage,
  normalizeSessionInfo,
  type Message,
  type SendResult,
  type SessionInfo,
} from "./types.ts";
import { finiteNumber, isRecord, isUnknownArray } from "./validation.ts";

const NOT_INSTALLED = 44;
/**
 * One constant command line: the request goes on stdin, so no argument needs quoting. `echo`
 * answers first, so a device that printed nothing was sent nothing. Then the first copy that Pi
 * installed under the home directory runs, from Git or from npm.
 */
const REMOTE_COMMAND = [
  "echo",
  ...["git/github.com/fitchmultz", "npm/node_modules/@fitchmultz"].map((root) => {
    const cli = `~/.pi/agent/${root}/pi-subagents/dist/pi-intercom/remote-cli.js`;
    return `test -f ${cli} && exec node ${cli}`;
  }),
  `exit ${NOT_INSTALLED}`,
].join("; ");
/** Never prompt, give up on a device that does not answer, and notice one that stops answering. */
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
];
const SSH_FAILED = 255;
/** Exit statuses of the remote shell that mean the device answered without running the command. */
const NOT_RUN: ReadonlyMap<unknown, string> = new Map([
  [NOT_INSTALLED, "its pi-subagents has no cross-device command; update pi-subagents there"],
  [127, "node is not on the PATH of its SSH commands"],
]);
/** How a package that lacks a command answers a request for it. */
const UNSUPPORTED = /^Unsupported command /;
const OLDER = "its pi-subagents is older than this command; update pi-subagents there";
const CHECK_FIRST = "Check the recipient before retrying; it may still arrive.";

/** The mains of one other device, or why they could not be listed, in a few words. */
export type DeviceListing =
  | {
      readonly device: string;
      readonly sessions: readonly SessionInfo[];
      /** The device's own clock when it listed. */
      readonly now: number;
    }
  | { readonly device: string; readonly failure: string };

/** A session of another device, written `name@device`. */
export interface DeviceTarget {
  /** This device's alias: the address of the sender. */
  readonly origin: string;
  readonly device: string;
  /** A session name or ID, resolved by that device. */
  readonly name: string;
}
type Sender = Readonly<Pick<IntercomTransport, "listSessions" | "sessionId">>;
type Options = Parameters<IntercomTransport["send"]>[1];

interface Exit {
  readonly error: ExecFileException | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The device answered, so it was sent the request. Otherwise it received nothing. */
  readonly requested: boolean;
}
type Reply = Readonly<Record<string, unknown>>;

function run(device: string, request: RemoteRequest, signal?: AbortSignal): Promise<Exit> {
  return new Promise((resolve) => {
    let requested = false;
    const child = execFile(
      "ssh",
      [...SSH_OPTIONS, device, REMOTE_COMMAND],
      // A reply holds at most one broker frame.
      { encoding: "utf8", signal, maxBuffer: 2 * MAX_FRAME_SIZE_BYTES },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr, requested });
      },
    );
    child.stdin?.on("error", () => {
      // ssh can exit before it reads the request; its exit status says why.
    });
    child.stdout?.once("data", () => {
      requested = true;
      child.stdin?.end(JSON.stringify(request));
    });
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1)?.trim() ?? "";
}

/** The version 1 reply: the last line that the device printed. */
function replyOf({ stdout }: Exit): Reply | undefined {
  try {
    const reply: unknown = JSON.parse(lastLine(stdout));
    return isRecord(reply) && reply.version === 1 ? reply : undefined;
  } catch {
    return undefined;
  }
}

/** Why a device gave no reply, in a few words, and whether it may have run the request. */
function noReply({ error, stderr, requested }: Exit): {
  readonly reason: string;
  readonly unreachable: boolean;
  readonly ran: boolean;
} {
  const words = lastLine(stderr)
    .slice(0, 200)
    .replace(/^ssh: /, "");
  const notRun = NOT_RUN.get(error?.code);
  if (notRun !== undefined) {
    return { reason: notRun, unreachable: false, ran: false };
  }
  if (error?.code === SSH_FAILED) {
    return { reason: words === "" ? "ssh failed" : words, unreachable: true, ran: requested };
  }
  return {
    reason: words === "" ? (error?.message ?? "unreadable reply") : words,
    unreachable: false,
    ran: requested,
  };
}

function sessionsOf(reply: Reply): readonly SessionInfo[] | undefined {
  if (!isUnknownArray(reply.sessions)) {
    return undefined;
  }
  const sessions = reply.sessions.map(normalizeSessionInfo);
  return sessions.every((session) => session !== null) ? sessions : undefined;
}

function listing(device: string, exit: Exit): DeviceListing {
  const reply = replyOf(exit);
  if (typeof reply?.error === "string") {
    return { device, failure: `not listed: ${lastLine(reply.error).slice(0, 200)}` };
  }
  const sessions = reply === undefined ? undefined : sessionsOf(reply);
  if (sessions !== undefined && finiteNumber(reply?.now)) {
    return { device, sessions, now: reply.now };
  }
  const { reason, unreachable } = noReply(exit);
  return { device, failure: unreachable ? `unreachable (${reason})` : `not listed: ${reason}` };
}

function receiptOf(value: unknown): SendResult | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.accepted !== "boolean" ||
    typeof value.delivered !== "boolean"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    accepted: value.accepted,
    delivered: value.delivered,
    ...(value.queued === true ? { queued: true } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

/** What a device did with a message: the broker's receipt, then the answer or why none came. */
interface Delivery {
  readonly receipt: SendResult;
  readonly reply?: Message | undefined;
  readonly noReply?: Error | undefined;
}

/** A SendError says whether the device received the message: `not-sent`, or `unconfirmed`. */
function notSent(messageId: string, cause: Readonly<Error>): SendError {
  return new SendError({ kind: "not-sent", messageId }, cause);
}
function unknown(messageId: string, words: string): SendError {
  return new SendError({ kind: "unconfirmed", messageId }, new Error(words));
}

/** Why a message request got no reply line. */
function unanswered(device: string, messageId: string, exit: Exit, signal?: AbortSignal): Error {
  if (signal?.aborted === true) {
    return exit.requested
      ? unknown(messageId, "Cancelled")
      : notSent(messageId, new Error("Cancelled"));
  }
  const { reason, unreachable, ran } = noReply(exit);
  return ran
    ? unknown(
        messageId,
        `Delivery unknown: ${device} gave no answer after the request was handed over (${reason}). ${CHECK_FIRST}`,
      )
    : notSent(
        messageId,
        new Error(`Not sent to ${device}: ${unreachable ? `unreachable (${reason})` : reason}`),
      );
}

/** What the device's reply line says about a message. Throws when it was not delivered. */
function delivery(device: string, messageId: string, reply: Reply): Delivery {
  const receipt = receiptOf(reply.receipt);
  if (typeof reply.error !== "string") {
    if (receipt === undefined) {
      throw unknown(
        messageId,
        `Delivery unknown: ${device} gave an unreadable answer. ${CHECK_FIRST}`,
      );
    }
    return { receipt, reply: normalizeMessage(reply.reply) ?? undefined };
  }
  if (receipt !== undefined) {
    return { receipt, noReply: refusal(reply.error, reply.code) };
  }
  if (reply.deliveryUnknown === true) {
    throw unknown(
      messageId,
      `Delivery unknown: ${device} did not confirm the delivery (${reply.error}). ${CHECK_FIRST}`,
    );
  }
  throw notSent(
    messageId,
    UNSUPPORTED.test(reply.error)
      ? new Error(`Not sent to ${device}: ${OLDER}`)
      : refusal(reply.error, reply.code),
  );
}

/** The device's own words, with the recovery code that a local refusal of that kind carries. */
function refusal(words: string, code: unknown): Error {
  return code === "ambiguous_target" || code === "reply_timeout"
    ? new RecoveryError(code, words)
    : new Error(words);
}

type Access =
  | { readonly self: string; readonly others: readonly string[] }
  | { readonly refusal: string };
type DeviceConfig = Pick<IntercomConfig, "device" | "otherDevices" | "askTimeoutMs">;

function access(config: DeviceConfig, child: boolean): Access {
  if (child) {
    return { refusal: "Only a main session reaches other devices. Ask your main to do it." };
  }
  if (config.device === undefined || config.otherDevices.length === 0) {
    return {
      refusal: `No devices are configured. Set "device" (this device's SSH alias) and "otherDevices" (the SSH aliases of your other devices) in ${intercomConfigPath()}.`,
    };
  }
  return { self: config.device, others: config.otherDevices };
}

/** The owner's other devices, reached with one `ssh` command per request. Nothing stays running. */
export class RemoteDevices {
  private readonly config: DeviceConfig;
  private readonly access: Access;
  constructor(config: DeviceConfig, child: boolean) {
    this.config = config;
    this.access = access(config, child);
  }
  /** Lists the mains of `selector`: one configured alias, or "all". Devices answer in parallel. */
  async list(
    selector: string,
    signal?: AbortSignal,
  ): Promise<{ readonly listings: readonly DeviceListing[] } | { readonly refusal: string }> {
    if ("refusal" in this.access) {
      return this.access;
    }
    const { self, others } = this.access;
    if (selector === self) {
      return { refusal: `"${self}" is this device. Omit 'device' to list its sessions.` };
    }
    if (selector !== "all" && !others.includes(selector)) {
      return {
        refusal: `Unknown device ${JSON.stringify(selector)}. Use "all" or one of: ${others.join(", ")}.`,
      };
    }
    const request: RemoteRequest = { version: 1, command: "list", origin: self };
    return {
      listings: await Promise.all(
        (selector === "all" ? others : [selector]).map(async (device) =>
          listing(device, await run(device, request, signal)),
        ),
      ),
    };
  }
  /**
   * The session of another device that `to` names as `name@device`, or undefined for a target
   * of this device. The text after the last `@` decides, in any letter case: a configured
   * device always wins over a local session with that name. Throws when this session may not
   * reach the device.
   */
  address(to: string): DeviceTarget | undefined {
    const target = to.trim();
    const at = target.lastIndexOf("@");
    const wanted = target.slice(at + 1).toLowerCase();
    const device = [this.config.device, ...this.config.otherDevices].find(
      (alias) => alias?.toLowerCase() === wanted,
    );
    if (at < 1 || device === undefined) {
      return undefined;
    }
    const name = target.slice(0, at);
    if (device === this.config.device) {
      throw new Error(`"${device}" is this device. Use the target ${JSON.stringify(name)}.`);
    }
    if ("refusal" in this.access) {
      throw new Error(this.access.refusal);
    }
    return { origin: this.access.self, device, name };
  }
  private async deliver(
    command: "send" | "ask",
    input: {
      readonly sender: Sender;
      readonly target: DeviceTarget;
      readonly options: Options;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<Delivery> {
    const { sender, target, options, signal } = input;
    const messageId = options.messageId ?? randomUUID();
    let from: SessionInfo | undefined;
    try {
      from = (await sender.listSessions()).find((session) => session.id === sender.sessionId);
      if (from === undefined) {
        throw new Error("Current session is missing from intercom session list.");
      }
    } catch (error) {
      throw new SendError(
        { kind: "not-sent", messageId },
        error instanceof Error ? error : new Error("Unknown sender"),
      );
    }
    const message: RemoteMessage = {
      version: 1,
      command,
      origin: target.origin,
      device: target.device,
      from: { id: from.id, name: from.name ?? from.id, cwd: from.cwd },
      to: target.name,
      message: { ...options, messageId },
      timeoutMs: this.config.askTimeoutMs,
    };
    const exit = await run(target.device, message, signal);
    const reply = replyOf(exit);
    if (reply === undefined) {
      throw unanswered(target.device, messageId, exit, signal);
    }
    return delivery(target.device, messageId, reply);
  }
  /**
   * Sends to a session of another device and returns that broker's receipt. Throws like a
   * local transport: a SendError says whether the device received anything.
   */
  async send(
    sender: Sender,
    target: DeviceTarget,
    message: { readonly options: Options; readonly signal?: AbortSignal | undefined },
  ): Promise<SendResult> {
    return (await this.deliver("send", { sender, target, ...message })).receipt;
  }
  /**
   * Asks a session of another device and waits for its reply, up to the ask timeout. `onSent`
   * gets the receipt of an accepted ask before a missing reply is thrown.
   */
  async ask(
    sender: Sender,
    target: DeviceTarget,
    request: {
      readonly options: Options;
      readonly signal?: AbortSignal | undefined;
      readonly onSent: (receipt: SendResult) => void;
    },
  ): Promise<Message> {
    const {
      receipt,
      reply,
      noReply: failure,
    } = await this.deliver("ask", {
      sender,
      target,
      options: request.options,
      signal: request.signal,
    });
    if (!receipt.accepted) {
      throw new AskDeliveryError(receipt);
    }
    request.onSent(receipt);
    if (reply === undefined) {
      throw failure ?? new Error(`${target.device} gave an unreadable reply.`);
    }
    return reply;
  }
}
