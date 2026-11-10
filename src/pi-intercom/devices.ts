import { execFile, type ExecFileException } from "node:child_process";
import { intercomConfigPath, type IntercomConfig } from "./config.ts";
import type { RemoteRequest } from "./remote-cli.ts";
import { normalizeSessionInfo, type SessionInfo } from "./types.ts";
import { finiteNumber, isRecord, isUnknownArray } from "./validation.ts";

const NOT_INSTALLED = 44;
/**
 * One constant command line: the request goes on stdin, so no argument needs quoting. It runs the
 * first copy that Pi installed under the home directory, from Git or from npm.
 */
const REMOTE_COMMAND = [
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

/** The mains of one other device, or why they could not be listed, in a few words. */
export type DeviceListing =
  | {
      readonly device: string;
      readonly sessions: readonly SessionInfo[];
      /** The device's own clock when it listed. */
      readonly now: number;
    }
  | { readonly device: string; readonly failure: string };

interface Exit {
  readonly error: ExecFileException | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(device: string, request: RemoteRequest, signal?: AbortSignal): Promise<Exit> {
  return new Promise((resolve) => {
    const child = execFile(
      "ssh",
      [...SSH_OPTIONS, device, REMOTE_COMMAND],
      { encoding: "utf8", signal },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      },
    );
    child.stdin?.on("error", () => {
      // ssh can exit before it reads the request; its exit status says why.
    });
    child.stdin?.end(JSON.stringify(request));
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1)?.trim().slice(0, 200) ?? "";
}

function failure({ error, stderr }: Exit): string {
  const reason = lastLine(stderr).replace(/^ssh: /, "");
  if (error?.code === SSH_FAILED) {
    return `unreachable (${reason === "" ? "ssh failed" : reason})`;
  }
  const detail = reason === "" ? (error?.message ?? "unreadable reply") : reason;
  return `not listed: ${NOT_RUN.get(error?.code) ?? detail}`;
}

function sessionsOf(reply: Readonly<Record<string, unknown>>): readonly SessionInfo[] | undefined {
  if (!isUnknownArray(reply.sessions)) {
    return undefined;
  }
  const sessions = reply.sessions.map(normalizeSessionInfo);
  return sessions.every((session) => session !== null) ? sessions : undefined;
}

function listing(device: string, exit: Exit): DeviceListing {
  let reply: unknown;
  try {
    reply = JSON.parse(exit.stdout);
  } catch {
    return { device, failure: failure(exit) };
  }
  if (!isRecord(reply) || reply.version !== 1) {
    return { device, failure: failure(exit) };
  }
  if (typeof reply.error === "string") {
    return { device, failure: `not listed: ${lastLine(reply.error)}` };
  }
  const sessions = sessionsOf(reply);
  return sessions === undefined || !finiteNumber(reply.now)
    ? { device, failure: failure(exit) }
    : { device, sessions, now: reply.now };
}

type Access =
  | { readonly self: string; readonly others: readonly string[] }
  | { readonly refusal: string };

function access(config: Pick<IntercomConfig, "device" | "otherDevices">, child: boolean): Access {
  if (child) {
    return {
      refusal:
        "Only a main session reaches other devices. Ask your main to do it, or omit 'device'.",
    };
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
  private readonly access: Access;
  constructor(config: Pick<IntercomConfig, "device" | "otherDevices">, child: boolean) {
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
}
