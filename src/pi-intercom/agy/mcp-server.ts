import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { IntercomToolParams } from "../runtime-types.ts";
import type { Attachment } from "../types.ts";
import { errorMessage, isRecord, isUnknownArray } from "../validation.ts";
import { AgyBridgeHub, type AgyToolCallContext } from "./hub.ts";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "pi-intercom";

const VALID_ACTIONS: readonly IntercomToolParams["action"][] = [
  "list",
  "send",
  "ask",
  "reply",
  "pending",
  "status",
  "last",
  "claim",
];

const INTERCOM_TOOL_DEFINITION = {
  name: "intercom",
  description:
    "Communicate with other local or cross-device Pi and Antigravity (agy) agent sessions on pi-intercom. Actions: list, status, pending, send (fire-and-forget), ask (send and wait for correlated reply), reply (answer a pending ask), last (read a peer's latest completed response without waking it), claim (publish or clear your workingOn summary).",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "status", "pending", "send", "ask", "reply", "last", "claim"],
        description: "Intercom action to perform.",
      },
      to: {
        type: "string",
        description:
          "Target peer name, session ID, or name@device (for send/ask/last/reply), or name/ID filter substring (for list).",
      },
      message: {
        type: "string",
        description:
          "Message text (for send/ask/reply) or short workingOn summary (for claim; empty string clears).",
      },
      replyTo: {
        type: "string",
        description: "Incoming message ID to correlate a reply with.",
      },
      scope: {
        type: "string",
        enum: ["project", "all"],
        description: "Session scope for list/status (default: all).",
      },
      children: {
        type: "boolean",
        description: "Include child session rows when listing (default: false).",
      },
      device: {
        type: "string",
        description:
          'List main sessions on another configured device alias, or "all" for every configured device.',
      },
      entryId: {
        type: "string",
        description: "Specific response entry ID to paginate with action='last'.",
      },
      offset: {
        type: "number",
        description: "UTF-16 character offset for action='last' pagination.",
      },
      limit: {
        type: "number",
        description: "Maximum UTF-16 characters to return for action='last' (1-16384).",
      },
      attachments: {
        type: "array",
        description: "Optional context/file/snippet attachments for send/ask/reply.",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["file", "snippet", "context"] },
            name: { type: "string" },
            content: { type: "string" },
            language: { type: "string" },
          },
          required: ["type", "name", "content"],
        },
      },
    },
    required: ["action"],
  },
} as const;

type JsonRpcId = string | number | null;

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseAction(value: unknown): IntercomToolParams["action"] | undefined {
  return VALID_ACTIONS.find((action) => action === value);
}

function optString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function parseAttachments(raw: unknown): readonly Attachment[] | undefined {
  if (!isUnknownArray(raw)) {
    return;
  }
  const items: Attachment[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      (item.type !== "file" && item.type !== "snippet" && item.type !== "context") ||
      typeof item.name !== "string" ||
      typeof item.content !== "string"
    ) {
      continue;
    }
    items.push({
      type: item.type,
      name: item.name,
      content: item.content,
      ...(typeof item.language === "string" ? { language: item.language } : {}),
    });
  }
  return items;
}

function parseToolParams(raw: unknown): IntercomToolParams | undefined {
  const action = isRecord(raw) ? parseAction(raw.action) : undefined;
  if (!isRecord(raw) || action === undefined) {
    return;
  }
  const scope = raw.scope === "project" || raw.scope === "all" ? raw.scope : undefined;
  const children = typeof raw.children === "boolean" ? raw.children : undefined;
  const attachments = parseAttachments(raw.attachments);
  const fields: Partial<IntercomToolParams> = {
    ...(scope !== undefined ? { scope } : {}),
    ...(children !== undefined ? { children } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
  const strings = {
    device: optString(raw, "device"),
    to: optString(raw, "to"),
    message: optString(raw, "message"),
    replyTo: optString(raw, "replyTo"),
    entryId: optString(raw, "entryId"),
  };
  const numbers = { offset: optNumber(raw, "offset"), limit: optNumber(raw, "limit") };
  return {
    action,
    ...fields,
    ...Object.fromEntries(Object.entries(strings).filter(([, value]) => value !== undefined)),
    ...Object.fromEntries(Object.entries(numbers).filter(([, value]) => value !== undefined)),
  };
}

function parseMetaContext(params: Readonly<Record<string, unknown>>): AgyToolCallContext {
  const meta = isRecord(params._meta) ? params._meta : undefined;
  if (!meta) {
    return {};
  }
  return {
    conversationId:
      typeof meta["antigravity.google/conversation_id"] === "string"
        ? meta["antigravity.google/conversation_id"]
        : undefined,
    rootConversationId:
      typeof meta["antigravity.google/root_conversation_id"] === "string"
        ? meta["antigravity.google/root_conversation_id"]
        : undefined,
    artifactsDir:
      typeof meta["antigravity.google/artifacts_dir"] === "string"
        ? meta["antigravity.google/artifacts_dir"]
        : undefined,
  };
}

function writeJsonRpc(message: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResult(id: JsonRpcId, result: unknown): void {
  writeJsonRpc({ jsonrpc: "2.0", id, result });
}

function writeError(id: JsonRpcId, code: number, message: string): void {
  writeJsonRpc({ jsonrpc: "2.0", id, error: { code, message } });
}

function parseJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }
  return;
}

export class AgyMcpServer {
  private readonly hub: AgyBridgeHub;
  private readonly version = packageVersion();
  private readonly inflight = new Map<string, AbortController>();

  constructor(hub: AgyBridgeHub) {
    this.hub = hub;
  }

  private cancelRequest(params: unknown): void {
    if (!isRecord(params)) {
      return;
    }
    const id = parseJsonRpcId(params.requestId);
    if (id === undefined || id === null) {
      return;
    }
    this.inflight.get(String(id))?.abort();
  }

  private async handleToolCall(
    id: JsonRpcId,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (params.name !== "intercom") {
      writeError(id, -32602, `Unknown tool: ${typeof params.name === "string" ? params.name : ""}`);
      return;
    }
    const toolParams = parseToolParams(params.arguments);
    if (!toolParams) {
      writeResult(id, {
        content: [
          { type: "text", text: "Invalid intercom tool arguments: missing or invalid action." },
        ],
        isError: true,
      });
      return;
    }
    const controller = new AbortController();
    const key = id === null ? null : String(id);
    if (key !== null) {
      this.inflight.set(key, controller);
    }
    try {
      const result = await this.hub.executeTool(
        toolParams,
        parseMetaContext(params),
        controller.signal,
      );
      writeResult(id, {
        content: result.content,
        ...(result.isError === true ? { isError: true } : {}),
      });
    } catch (error) {
      writeResult(id, {
        content: [{ type: "text", text: `Intercom tool failed: ${errorMessage(error)}` }],
        isError: true,
      });
    } finally {
      if (key !== null && this.inflight.get(key) === controller) {
        this.inflight.delete(key);
      }
    }
  }

  private async dispatchRequest(
    id: JsonRpcId,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    switch (method) {
      case "initialize":
        writeResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: this.version },
        });
        return;
      case "ping":
        writeResult(id, {});
        return;
      case "tools/list":
        writeResult(id, { tools: [INTERCOM_TOOL_DEFINITION] });
        return;
      case "tools/call":
        await this.handleToolCall(id, params);
        return;
      default:
        writeError(id, -32601, `Method not found: ${method}`);
    }
  }

  async handleLine(line: string): Promise<void> {
    if (line.trim() === "") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeError(null, -32700, "Parse error");
      return;
    }
    if (!isRecord(parsed) || typeof parsed.method !== "string") {
      return;
    }
    const params = isRecord(parsed.params) ? parsed.params : {};
    if (parsed.method === "notifications/cancelled") {
      this.cancelRequest(params);
      return;
    }
    const id = parseJsonRpcId(parsed.id);
    if (id !== undefined) {
      await this.dispatchRequest(id, parsed.method, params);
    }
  }

  abortAll(): void {
    for (const controller of this.inflight.values()) {
      controller.abort();
    }
    this.inflight.clear();
  }
}

export async function runAgyMcpServer(): Promise<void> {
  const hub = new AgyBridgeHub(process.ppid);
  await hub.start();
  const server = new AgyMcpServer(hub);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.abortAll();
    await hub.close();
  };

  const handleSignal = () => {
    void shutdown()
      .catch(() => {
        // Ignore shutdown errors when exiting on signal.
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    void server.handleLine(line).catch(() => {
      // Errors are serialized per JSON-RPC request inside handleLine.
    });
  });
  await new Promise<void>((resolve) => {
    rl.once("close", resolve);
  });
  await shutdown();
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runAgyMcpServer().catch((error: unknown) => {
    process.stderr.write(`pi-intercom agy MCP server failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
