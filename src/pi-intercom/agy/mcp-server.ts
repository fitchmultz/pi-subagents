import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { arr, bool, compile, int, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { IntercomToolParams } from "../runtime-types.ts";
import { errorMessage, isRecord } from "../validation.ts";
import { AgyBridgeHub, type AgyToolCallContext } from "./hub.ts";

const SUPPORTED_MCP_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const DEFAULT_MCP_PROTOCOL = SUPPORTED_MCP_PROTOCOLS[0];
const SERVER_NAME = "pi-intercom";

const AGY_INTERCOM_INPUT_SCHEMA = obj({
  action: union([
    lit("list"),
    lit("send"),
    lit("ask"),
    lit("reply"),
    lit("pending"),
    lit("status"),
    lit("last"),
    lit("claim"),
  ]),
  scope: opt(
    union([lit("project"), lit("all")], {
      description: "all (default) or project (repo and worktrees)",
    }),
  ),
  children: opt(bool({ description: "list: print child rows instead of a count" })),
  device: opt(str({ description: "list: mains on another device (alias) or all" })),
  to: opt(str({ description: "Session name or ID" })),
  message: opt(
    str({
      description:
        "Text for send/ask/reply, or workingOn note for claim (one line, max 256 UTF-16 code units after normalization; empty clears)",
    }),
  ),
  attachments: opt(
    arr(
      obj({
        type: union([lit("file"), lit("snippet"), lit("context")]),
        name: str(),
        content: str(),
        language: opt(str()),
      }),
    ),
  ),
  replyTo: opt(str({ description: "Message ID to answer or thread" })),
  entryId: opt(str()),
  offset: opt(int({ minimum: 0, description: "UTF-16 characters" })),
  limit: opt(int({ minimum: 1, maximum: 16384 })),
});

const intercomValidator = compile(AGY_INTERCOM_INPUT_SCHEMA);

const INTERCOM_TOOL_DEFINITION = {
  name: "intercom",
  description:
    "Communicate with other local or cross-device Pi and Antigravity (agy) agent sessions on pi-intercom. Actions: list, status, pending, send (fire-and-forget), ask (send and wait for correlated reply), reply (answer a pending ask), last (read a peer's latest completed response without waking it), claim (publish or clear your workingOn summary).",
  inputSchema: AGY_INTERCOM_INPUT_SCHEMA,
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

function negotiateProtocolVersion(params: Readonly<Record<string, unknown>>): string {
  const requested = params.protocolVersion;
  if (
    typeof requested === "string" &&
    SUPPORTED_MCP_PROTOCOLS.some((version) => version === requested)
  ) {
    return requested;
  }
  return DEFAULT_MCP_PROTOCOL;
}

function validateToolParams(
  raw: unknown,
):
  | { readonly ok: true; readonly value: IntercomToolParams }
  | { readonly ok: false; readonly message: string } {
  const validated = intercomValidator.validate(raw);
  if (!validated.ok) {
    const detail = validated.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
    return { ok: false, message: `Invalid intercom tool arguments: ${detail}` };
  }
  return { ok: true, value: validated.value };
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
    const parsed = validateToolParams(params.arguments);
    if (!parsed.ok) {
      writeResult(id, {
        content: [{ type: "text", text: parsed.message }],
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
        parsed.value,
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
          protocolVersion: negotiateProtocolVersion(params),
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
