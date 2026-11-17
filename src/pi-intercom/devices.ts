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
// `echo` answers before stdin is written, proving whether a silent connection ever received the request.
const REMOTE_COMMAND = [
  "echo",
  ...["git/github.com/fitchmultz", "npm/node_modules/@fitchmultz"].map((root) => {
    const cli = `~/.pi/agent/${root}/pi-subagents/dist/pi-intercom/remote-cli.js`;
    return `test -f ${cli} && exec node ${cli}`;
  }),
  `exit ${NOT_INSTALLED}`,
].join("; ");
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
const NOT_RUN: ReadonlyMap<unknown, string> = new Map([
  [NOT_INSTALLED, "its pi-subagents has no cross-device command; update pi-subagents there"],
  [127, "node is not on the PATH of its SSH commands"],
]);
const UNSUPPORTED = /^Unsupported command /;
const OLDER = "its pi-subagents is older than this command; update pi-subagents there";
const CHECK_FIRST = "Check the recipient before retrying; it may still arrive.";

export type DeviceListing =
  | {
      readonly device: string;
      readonly sessions: readonly SessionInfo[];
      readonly now: number;
    }
  | { readonly device: string; readonly failure: string };

export interface DeviceTarget {
  readonly origin: string;
  readonly device: string;
  readonly name: string;
}
type Sender = Readonly<Pick<IntercomTransport, "listSessions" | "sessionId">>;
type Options = Parameters<IntercomTransport["send"]>[1];

interface Exit {
  readonly error: ExecFileException | null;
  readonly stdout: string;
  readonly stderr: string;
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

function replyOf({ stdout }: Exit): Reply | undefined {
  try {
    const reply: unknown = JSON.parse(lastLine(stdout));
    return isRecord(reply) && reply.version === 1 ? reply : undefined;
  } catch {
    return undefined;
  }
}

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
  return { reason: words === "" ? stopped(error) : words, unreachable: false, ran: requested };
}

function stopped(error: ExecFileException | null): string {
  if (typeof error?.signal === "string") {
    return `ssh was stopped by ${error.signal}`;
  }
  if (typeof error?.code === "number") {
    return `exit status ${error.code}`;
  }
  return error?.message ?? "unreadable reply";
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

type Exchange =
  | { readonly kind: "not-sent"; readonly error: Error }
  | { readonly kind: "unknown"; readonly error: Error }
  | { readonly kind: "answered"; readonly receipt: SendResult; readonly reply: Message }
  | { readonly kind: "accepted"; readonly receipt: SendResult }
  | { readonly kind: "unanswered"; readonly receipt: SendResult; readonly reason: Error };

function notSent(messageId: string, cause: Readonly<Error>): SendError {
  return new SendError({ kind: "not-sent", messageId }, cause);
}
function unknown(messageId: string, words: string): SendError {
  return new SendError({ kind: "unconfirmed", messageId }, new Error(words));
}

function unanswered(
  device: string,
  messageId: string,
  exit: Exit,
  signal?: AbortSignal,
): Extract<Exchange, { kind: "not-sent" | "unknown" }> {
  if (signal?.aborted === true) {
    return exit.requested
      ? { kind: "unknown", error: unknown(messageId, "Cancelled") }
      : { kind: "not-sent", error: notSent(messageId, new Error("Cancelled")) };
  }
  const { reason, unreachable, ran } = noReply(exit);
  return ran
    ? {
        kind: "unknown",
        error: unknown(
          messageId,
          `Delivery unknown: ${device} gave no answer after the request was handed over (${reason}). ${CHECK_FIRST}`,
        ),
      }
    : {
        kind: "not-sent",
        error: notSent(
          messageId,
          new Error(`Not sent to ${device}: ${unreachable ? `unreachable (${reason})` : reason}`),
        ),
      };
}

function lostReply(device: string, exit: Exit, signal?: AbortSignal): Error {
  return new Error(
    signal?.aborted === true
      ? "Cancelled"
      : `The ask reached ${device}, and the connection was lost before a reply came (${noReply(exit).reason}).`,
  );
}

function exchange(options: {
  readonly device: string;
  readonly messageId: string;
  readonly expectsReply: boolean;
  readonly exit: Exit;
  readonly signal: AbortSignal | undefined;
  readonly reply: Reply;
}): Exchange {
  const { device, messageId, expectsReply, exit, signal, reply } = options;
  const receipt = receiptOf(reply.receipt);
  if (typeof reply.error !== "string") {
    if (receipt === undefined) {
      return {
        kind: "unknown",
        error: unknown(
          messageId,
          `Delivery unknown: ${device} gave an unreadable answer. ${CHECK_FIRST}`,
        ),
      };
    }
    const message = normalizeMessage(reply.reply) ?? undefined;
    if (message !== undefined) {
      return { kind: "answered", receipt, reply: message };
    }
    return expectsReply
      ? { kind: "unanswered", receipt, reason: lostReply(device, exit, signal) }
      : { kind: "accepted", receipt };
  }
  if (receipt !== undefined) {
    return expectsReply
      ? { kind: "unanswered", receipt, reason: refusal(reply.error, reply.code) }
      : { kind: "accepted", receipt };
  }
  if (reply.deliveryUnknown === true) {
    return {
      kind: "unknown",
      error: unknown(
        messageId,
        `Delivery unknown: ${device} did not confirm the delivery (${reply.error}). ${CHECK_FIRST}`,
      ),
    };
  }
  return {
    kind: "not-sent",
    error: notSent(
      messageId,
      UNSUPPORTED.test(reply.error)
        ? new Error(`Not sent to ${device}: ${OLDER}`)
        : refusal(reply.error, reply.code),
    ),
  };
}

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

export class RemoteDevices {
  private readonly config: DeviceConfig;
  private readonly access: Access;
  constructor(config: DeviceConfig, child: boolean) {
    this.config = config;
    this.access = access(config, child);
  }
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
  // Configured `@device` suffixes take case-insensitive precedence over local names.
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
  ): Promise<Exchange> {
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
    return reply === undefined
      ? unanswered(target.device, messageId, exit, signal)
      : exchange({
          device: target.device,
          messageId,
          expectsReply: command === "ask",
          exit,
          signal,
          reply,
        });
  }
  async send(
    sender: Sender,
    target: DeviceTarget,
    message: { readonly options: Options; readonly signal?: AbortSignal | undefined },
  ): Promise<SendResult> {
    const result = await this.deliver("send", { sender, target, ...message });
    if (result.kind === "not-sent" || result.kind === "unknown") {
      throw result.error;
    }
    return result.receipt;
  }
  async ask(
    sender: Sender,
    target: DeviceTarget,
    request: {
      readonly options: Options;
      readonly signal?: AbortSignal | undefined;
      readonly onSent: (receipt: SendResult) => void;
    },
  ): Promise<Message> {
    const result = await this.deliver("ask", {
      sender,
      target,
      options: request.options,
      signal: request.signal,
    });
    if (result.kind === "not-sent" || result.kind === "unknown") {
      throw result.error;
    }
    if (!result.receipt.accepted) {
      throw new AskDeliveryError(result.receipt);
    }
    request.onSent(result.receipt);
    if (result.kind === "answered") {
      return result.reply;
    }
    throw result.kind === "unanswered"
      ? result.reason
      : new Error(`The ask to ${target.device} was accepted without a reply or a reason.`);
  }
}
