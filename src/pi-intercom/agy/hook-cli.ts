import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { agyControlSocketPath } from "../broker/paths.ts";
import { isRecord } from "../validation.ts";
import { isValidConversationId, readConversationIndex } from "./paths.ts";

const HOOK_TIMEOUT_MS = 2000;
const SESSION_START_RETRY_MS = 100;
const SESSION_START_MAX_WAIT_MS = 1500;
const TITLE_TIMEOUT_MS = 300;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendControlRequest(
  socketPath: string,
  request: Readonly<Record<string, unknown>>,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const finish = (value?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref();
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        finish(buffer.slice(0, newline));
      }
    });
    socket.on("error", () => finish());
    socket.on("close", () => finish(buffer.trim() === "" ? undefined : buffer.trim()));
  });
}

function fallbackHookResponse(payload: unknown): string {
  if (isRecord(payload) && payload.hookEventName === "PreToolUse") {
    return '{"decision":"allow"}';
  }
  return "{}";
}

function parseJsonObject(raw: string): Readonly<Record<string, unknown>> | undefined {
  if (raw.trim() === "") {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return;
  }
}

async function sendHookRequest(
  socketPath: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<string | undefined> {
  const isSessionStart = payload.hookEventName === "SessionStart";
  const deadline = isSessionStart ? Date.now() + SESSION_START_MAX_WAIT_MS : 0;
  for (;;) {
    const response = await sendControlRequest(
      socketPath,
      { type: "hook", payload },
      HOOK_TIMEOUT_MS,
    );
    if (response !== undefined || !isSessionStart || Date.now() >= deadline) {
      return response;
    }
    await delay(SESSION_START_RETRY_MS);
  }
}

async function handleHookCommand(raw: string): Promise<void> {
  const payload = parseJsonObject(raw) ?? {};
  const fallback = fallbackHookResponse(payload);
  let socketPath: string | undefined;
  try {
    socketPath = agyControlSocketPath(process.ppid);
  } catch {
    process.stdout.write(`${fallback}\n`);
    return;
  }
  const response = await sendHookRequest(socketPath, payload);
  const validResponse =
    response !== undefined && parseJsonObject(response) !== undefined ? response : fallback;
  process.stdout.write(`${validResponse}\n`);
}

function titleField(payload: Readonly<Record<string, unknown>>): string | undefined {
  const title = payload.conversation_title;
  return typeof title === "string" && title.trim() !== "" ? title.trim() : undefined;
}

function titleCwd(payload: Readonly<Record<string, unknown>>): string | undefined {
  if (isRecord(payload.workspace) && typeof payload.workspace.project_dir === "string") {
    return payload.workspace.project_dir;
  }
  return typeof payload.cwd === "string" ? payload.cwd : undefined;
}

function titleModel(payload: Readonly<Record<string, unknown>>): string | undefined {
  if (isRecord(payload.model) && typeof payload.model.display_name === "string") {
    return payload.model.display_name;
  }
  return undefined;
}

async function handleTitleCommand(raw: string): Promise<void> {
  const payload = parseJsonObject(raw);
  if (!payload) {
    return;
  }
  const conversationId =
    typeof payload.conversation_id === "string" ? payload.conversation_id : undefined;
  if (!isValidConversationId(conversationId)) {
    return;
  }
  const index = readConversationIndex(conversationId);
  if (!index) {
    return;
  }
  await sendControlRequest(
    index.socketPath,
    {
      type: "title",
      conversationId,
      title: titleField(payload),
      cwd: titleCwd(payload),
      modelName: titleModel(payload),
    },
    TITLE_TIMEOUT_MS,
  );
}

export async function runAgyHookCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const raw = await readStdin();
  if (argv[0] === "title") {
    await handleTitleCommand(raw);
    return;
  }
  await handleHookCommand(raw);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runAgyHookCli().catch(() => {
    // Always fail open so agy hooks are never disrupted.
    process.stdout.write("{}\n");
  });
}
