import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPiAgentDir } from "../agent-dir.ts";
import { agyControlSocketPath, preparePrivateSocketPath } from "../broker/paths.ts";
import { isRecord } from "../validation.ts";

const CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;
const LOOPBACK_LS_ADDRESS_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/;

export interface AgyWakeCredentials {
  readonly lsAddress: string;
  readonly csrfToken: string;
  readonly agentApiExe?: string | undefined;
}

export interface AgyConversationIndex {
  readonly socketPath: string;
  readonly lsPid: number;
  readonly mcpPid: number;
}

export interface AgentApiInvocation {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export function isValidConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_RE.test(value);
}

export function agyPeerId(conversationId: string): string {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    throw new Error(`Invalid Antigravity conversation ID: ${conversationId}`);
  }
  return `agy-${conversationId}`;
}

export function preparePrivateDir(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`Unsafe intercom agy directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

export function agyStateDir(): string {
  return join(getPiAgentDir(), "intercom", "agy");
}

export function agyWakeDir(): string {
  return join(getPiAgentDir(), "intercom", "agy-wake");
}

export function agyWakeFilePath(conversationId: string): string {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    throw new Error(`Invalid Antigravity conversation ID: ${conversationId}`);
  }
  return join(agyWakeDir(), `${conversationId}.env`);
}

export function agyConversationIndexPath(conversationId: string): string {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    throw new Error(`Invalid Antigravity conversation ID: ${conversationId}`);
  }
  return join(agyStateDir(), `conv-${conversationId}.json`);
}

export function prepareAgyControlSocketPath(lsPid: number): string {
  return preparePrivateSocketPath(agyControlSocketPath(lsPid));
}

function isOwnedRegularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    const uid = process.getuid?.();
    return stat.isFile() && !stat.isSymbolicLink() && (uid === undefined || stat.uid === uid);
  } catch {
    return false;
  }
}

function isValidLoopbackAddress(value: string): boolean {
  const match = LOOPBACK_LS_ADDRESS_RE.exec(value);
  if (!match) {
    return false;
  }
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function parseWakeCredentials(raw: string): AgyWakeCredentials | undefined {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const lsAddress = values.get("ANTIGRAVITY_LS_ADDRESS") ?? "";
  const csrfToken = values.get("ANTIGRAVITY_CSRF_TOKEN") ?? "";
  const agentApiExe = values.get("ANTIGRAVITY_AGENTAPI_EXE") ?? "";
  if (!isValidLoopbackAddress(lsAddress) || csrfToken === "") {
    return;
  }
  return {
    lsAddress,
    csrfToken,
    ...(agentApiExe !== "" ? { agentApiExe } : {}),
  };
}

export function readWakeCredentials(conversationId: string): AgyWakeCredentials | undefined {
  if (!isValidConversationId(conversationId)) {
    return;
  }
  const filePath = agyWakeFilePath(conversationId);
  if (!isOwnedRegularFile(filePath)) {
    return;
  }
  try {
    return parseWakeCredentials(fs.readFileSync(filePath, "utf8"));
  } catch {
    return;
  }
}

export function removeFileQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Missing or already cleaned up.
  }
}

export function writeConversationIndex(
  conversationId: string,
  entry: AgyConversationIndex,
): string {
  const dir = preparePrivateDir(agyStateDir());
  const target = agyConversationIndexPath(conversationId);
  const tmp = join(dir, `.conv-${conversationId}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

export function readConversationIndex(conversationId: string): AgyConversationIndex | undefined {
  if (!isValidConversationId(conversationId)) {
    return;
  }
  const filePath = agyConversationIndexPath(conversationId);
  if (!isOwnedRegularFile(filePath)) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      !isRecord(parsed) ||
      typeof parsed.socketPath !== "string" ||
      typeof parsed.lsPid !== "number" ||
      typeof parsed.mcpPid !== "number"
    ) {
      return;
    }
    return { socketPath: parsed.socketPath, lsPid: parsed.lsPid, mcpPid: parsed.mcpPid };
  } catch {
    return;
  }
}

export function resolveAgentApiCommand(agentApiExe?: string): AgentApiInvocation {
  if (agentApiExe !== undefined && agentApiExe !== "") {
    return { command: agentApiExe, prefixArgs: ["agentapi"] };
  }
  const wrapper = join(homedir(), ".gemini", "antigravity-cli", "bin", "agentapi");
  if (fs.existsSync(wrapper)) {
    return { command: wrapper, prefixArgs: [] };
  }
  return { command: "agy", prefixArgs: ["agentapi"] };
}
