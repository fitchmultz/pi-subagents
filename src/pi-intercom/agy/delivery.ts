import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatAttachments } from "../message-format.ts";
import type { Message, SessionInfo } from "../types.ts";
import { errorMessage, isRecord } from "../validation.ts";
import { resolveAgentApiCommand, type AgyWakeCredentials } from "./paths.ts";

const execFileAsync = promisify(execFile);
const AGENTAPI_TIMEOUT_MS = 10_000;

export interface AgentApiDeliveryResult {
  readonly ok: boolean;
  readonly reason?: string | undefined;
}

export interface ConversationLineage {
  readonly isSubagent: boolean;
}

export function formatAgyInboundMessage(
  from: SessionInfo,
  message: Message,
  options: { readonly replyHint: boolean; readonly replyTarget?: string | undefined },
): string {
  const sender = from.name !== undefined && from.name !== "" ? from.name : from.id.slice(0, 8);
  const body = `${message.content.text}${formatAttachments(message.content.attachments ?? [])}`;
  const replyLine = buildReplyInstruction(from, message, options);
  const header = `**Intercom message from ${sender}** (peer: ${from.id}, cwd: ${from.cwd})${replyLine}`;
  return `${header}\n\n${body}`;
}

function buildReplyInstruction(
  from: SessionInfo,
  message: Message,
  options: { readonly replyHint: boolean; readonly replyTarget?: string | undefined },
): string {
  if (message.expectsReply === true) {
    const command = `intercom(${JSON.stringify({ action: "reply", replyTo: message.id, message: "..." })})`;
    return `\n\nThis peer is waiting for your reply. Call the intercom MCP tool: ${command}`;
  }
  if (!options.replyHint) {
    return "";
  }
  const target = options.replyTarget ?? from.id;
  const command = `intercom(${JSON.stringify({ action: "send", to: target, message: "..." })})`;
  return `\n\nTo reply, call the intercom MCP tool: ${command}`;
}

export function formatAgyInboundTitle(from: SessionInfo, expectsReply: boolean): string {
  const sender = from.name !== undefined && from.name !== "" ? from.name : from.id.slice(0, 8);
  return expectsReply ? `Intercom ask from ${sender}` : `Intercom from ${sender}`;
}

export async function sendViaAgentApi(
  credentials: AgyWakeCredentials,
  conversationId: string,
  title: string,
  content: string,
): Promise<AgentApiDeliveryResult> {
  const { command, prefixArgs } = resolveAgentApiCommand(credentials.agentApiExe);
  const args = [...prefixArgs, "send-message", `--title=${title}`, conversationId, content];
  const env = {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: credentials.lsAddress,
    ANTIGRAVITY_CSRF_TOKEN: credentials.csrfToken,
  };
  try {
    await execFileAsync(command, args, {
      env,
      timeout: AGENTAPI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export async function inspectConversationLineage(
  credentials: AgyWakeCredentials,
  conversationId: string,
): Promise<ConversationLineage | undefined> {
  const { command, prefixArgs } = resolveAgentApiCommand(credentials.agentApiExe);
  const env = {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: credentials.lsAddress,
    ANTIGRAVITY_CSRF_TOKEN: credentials.csrfToken,
  };
  try {
    const { stdout } = await execFileAsync(
      command,
      [...prefixArgs, "get-conversation-metadata", conversationId],
      { env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout);
    const metadata = extractMetadata(parsed);
    if (!metadata) {
      return;
    }
    const parentId =
      typeof metadata.parentConversationId === "string" ? metadata.parentConversationId : "";
    const nestingDepth = typeof metadata.nestingDepth === "number" ? metadata.nestingDepth : 0;
    const isSubagent = parentId !== "" || nestingDepth > 0 || metadata.subagentSpec !== null;
    return { isSubagent };
  } catch {
    return;
  }
}

function extractMetadata(parsed: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(parsed) || !isRecord(parsed.response)) {
    return;
  }
  const convMeta = parsed.response.conversationMetadata;
  if (!isRecord(convMeta) || !isRecord(convMeta.metadata)) {
    return;
  }
  return convMeta.metadata;
}
