import { EventEmitter, once } from "node:events";
import https from "node:https";
import { readFileSync } from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { errorMessage, type UnknownRecord } from "../../src/shared/unknown.ts";
import { assertDefined, json, numberValue, record, text } from "./assertions.ts";

const repo = resolve(import.meta.dirname, "../..");
interface Credential {
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
  readonly fingerprint256: string;
}
export interface BridgeProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly wait: (pattern: RegExp, after?: number) => Promise<string>;
}
export interface BridgeApi {
  readonly url: string;
  readonly host: unknown;
  readonly api: (
    action: string,
    body?: unknown,
    extra?: object,
  ) => Promise<{ readonly status: number; readonly body: UnknownRecord }>;
}
export async function bridgeApi(bridge: BridgeProcess, credential: Credential): Promise<BridgeApi> {
  const listening = await bridge.wait(/"event":"listening"/);
  const ready = listening
    .split("\n")
    .filter((line) => line !== "")
    .map(json)
    .find((line) => line.event === "listening");
  assertDefined(ready);
  const url = `https://127.0.0.1:${numberValue(ready.port)}`;
  return { url, api: bridgeRequest(url, credential), host: ready.host };
}
export function parseCredential(value: unknown): Credential {
  const input = record(value);
  return {
    ca: text(input.ca),
    cert: text(input.cert),
    key: text(input.key),
    fingerprint256: text(input.fingerprint256),
  };
}
export function bridgeRequest(url: string, credential: Credential): BridgeApi["api"] {
  const tls = {
    ca: readFileSync(credential.ca),
    cert: readFileSync(credential.cert),
    key: readFileSync(credential.key),
    rejectUnauthorized: true,
    agent: false as const,
  };
  return (action: string, body?: unknown, extra = {}) =>
    new Promise<{ readonly status: number; readonly body: UnknownRecord }>((resolveApi, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        `${url}/v1/${action}`,
        {
          ...tls,
          method: payload === undefined ? "GET" : "POST",
          headers: payload === undefined ? {} : { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(15000),
          ...extra,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString("utf8");
          });
          res.on("error", reject);
          res.on("end", () => {
            let parsed: UnknownRecord;
            try {
              parsed = json(data);
            } catch (error) {
              reject(error instanceof Error ? error : new Error("Invalid bridge response"));
              return;
            }
            resolveApi({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
}
export function exec(
  file: string,
  args: readonly string[],
  options: { readonly env?: Readonly<NodeJS.ProcessEnv> } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise<{ readonly stdout: string; readonly stderr: string }>(
    (resolveExec, reject) => {
      execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`${errorMessage(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
              cause: error,
            }),
          );
        } else {
          resolveExec({ stdout, stderr });
        }
      });
    },
  );
}
export function start(
  file: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): BridgeProcess {
  const child = spawn(process.execPath, [join(repo, file), ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events = new EventEmitter();
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    events.emit("output");
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
    events.emit("output");
  });
  child.on("exit", () => {
    events.emit("output");
  });
  child.on("error", (error) => {
    output += error.message;
    events.emit("output");
  });
  return {
    child,
    output: (): string => output,
    wait: (pattern: RegExp, after = 0): Promise<string> =>
      new Promise<string>((resolveWait, reject) => {
        const finish = (error?: Readonly<Error>) => {
          clearTimeout(timer);
          events.off("output", check);
          if (error) {
            reject(error);
          } else {
            resolveWait(output);
          }
        };
        const timer = setTimeout(
          () => finish(new Error(`No ${pattern.toString()}: ${output}`)),
          15000,
        );
        const check = () => {
          if (pattern.test(output.slice(after))) {
            finish();
          } else if (child.exitCode !== null || child.signalCode !== null) {
            finish(new Error(`Exited before ${pattern.toString()}: ${output}`));
          }
        };
        events.on("output", check);
        check();
      }),
  };
}
export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "close");
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 10000);
  child.kill("SIGTERM");
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
