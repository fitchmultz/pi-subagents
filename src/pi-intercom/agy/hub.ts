import * as fs from "node:fs";
import net from "node:net";
import { loadConfig, type IntercomConfig } from "../config.ts";
import type { IntercomToolParams, ToolResultLike } from "../runtime-types.ts";
import { toolError } from "../tool-arguments.ts";
import { isRecord, isUnknownArray } from "../validation.ts";
import { inspectConversationLineage } from "./delivery.ts";
import {
  agyWakeDir,
  captureEndpointIdentity,
  isOwnedEndpointCurrent,
  isValidConversationId,
  prepareAgyControlSocketPath,
  preparePrivateDir,
  readWakeCredentials,
  removeOwnedEndpoint,
  writeConversationIndex,
  type OwnedEndpoint,
} from "./paths.ts";
import { AgyPeer, type AgyHookInput, type AgyHookResponse } from "./peer.ts";

const MAX_CONTROL_LINE_BYTES = 256 * 1024;
const SOCKET_PROBE_TIMEOUT_MS = 250;
const SUBAGENT_TRIGGER_TOOLS = new Set(["invoke_subagent", "swarm", "run_workflow"]);

function isControlSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (live: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => finish(true), SOCKET_PROBE_TIMEOUT_MS);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export interface AgyToolCallContext {
  readonly conversationId?: string | undefined;
  readonly rootConversationId?: string | undefined;
  readonly artifactsDir?: string | undefined;
}

interface ControlHookRequest {
  readonly type: "hook";
  readonly payload: AgyHookInput;
}

interface ControlTitleRequest {
  readonly type: "title";
  readonly conversationId: string;
  readonly title?: string | undefined;
  readonly cwd?: string | undefined;
  readonly transcriptPath?: string | undefined;
  readonly modelName?: string | undefined;
}

type ControlRequest = ControlHookRequest | ControlTitleRequest;

function optionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function parseHookInput(raw: unknown): AgyHookInput {
  if (!isRecord(raw)) {
    return {};
  }
  const toolCall = isRecord(raw.toolCall) ? raw.toolCall : undefined;
  const workspacePaths = isUnknownArray(raw.workspacePaths)
    ? raw.workspacePaths.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    hookEventName: optionalString(raw, "hookEventName"),
    conversationId: optionalString(raw, "conversationId"),
    cwd: optionalString(raw, "cwd"),
    workspacePaths,
    transcriptPath: optionalString(raw, "transcriptPath"),
    modelName: optionalString(raw, "modelName"),
    toolName: toolCall ? optionalString(toolCall, "name") : undefined,
    terminationReason: optionalString(raw, "terminationReason"),
    fullyIdle: typeof raw.fullyIdle === "boolean" ? raw.fullyIdle : undefined,
  };
}

function parseControlRequest(raw: unknown): ControlRequest | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return;
  }
  if (raw.type === "hook") {
    return { type: "hook", payload: parseHookInput(raw.payload) };
  }
  if (raw.type === "title" && isValidConversationId(raw.conversationId)) {
    return {
      type: "title",
      conversationId: raw.conversationId,
      title: typeof raw.title === "string" ? raw.title : undefined,
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      transcriptPath: typeof raw.transcriptPath === "string" ? raw.transcriptPath : undefined,
      modelName: typeof raw.modelName === "string" ? raw.modelName : undefined,
    };
  }
  return;
}

function inferTranscriptPath(artifactsDir: string | undefined): string | undefined {
  if (artifactsDir === undefined || artifactsDir === "") {
    return;
  }
  return `${artifactsDir}/.system_generated/logs/transcript.jsonl`;
}

export class AgyBridgeHub {
  private readonly lsPid: number;
  private readonly config: IntercomConfig;
  private readonly peers = new Map<string, AgyPeer>();
  private readonly subagentIds = new Set<string>();
  private readonly ownedIndexFiles = new Map<string, OwnedEndpoint>();
  private activeMainId: string | null = null;
  private server: net.Server | null = null;
  private ownedSocket: OwnedEndpoint | null = null;
  private socketPath: string | null = null;
  private closed = false;

  constructor(
    lsPid = process.ppid,
    config = loadConfig(() => {
      /* Silence config noise on MCP stderr. */
    }),
  ) {
    this.lsPid = lsPid;
    this.config = config;
  }

  get controlSocketPath(): string | null {
    return this.socketPath;
  }

  async start(): Promise<string | null> {
    preparePrivateDir(agyWakeDir());
    const socketPath = prepareAgyControlSocketPath(this.lsPid);
    const existing = captureEndpointIdentity(socketPath);
    if (existing) {
      if (await isControlSocketLive(socketPath)) {
        return null;
      }
      removeOwnedEndpoint(existing);
    }
    const server = net.createServer((socket) => this.handleControlConnection(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          try {
            fs.chmodSync(socketPath, 0o600);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    } catch (error) {
      server.close();
      if (await isControlSocketLive(socketPath)) {
        return null;
      }
      throw error;
    }
    this.server = server;
    this.ownedSocket = captureEndpointIdentity(socketPath) ?? null;
    this.socketPath = socketPath;
    return socketPath;
  }

  private handleControlConnection(socket: net.Socket): void {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (handled) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_CONTROL_LINE_BYTES) {
        handled = true;
        socket.end("{}\n");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      handled = true;
      const line = buffer.slice(0, newline);
      void this.dispatchControlLine(line)
        .then((response) => {
          socket.end(`${JSON.stringify(response)}\n`);
        })
        .catch(() => {
          socket.end("{}\n");
        });
    });
    socket.on("error", () => {
      // Short-lived hook connections may abort on timeout.
    });
  }

  private async dispatchControlLine(line: string): Promise<AgyHookResponse> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return {};
    }
    const request = parseControlRequest(parsed);
    if (!request) {
      return {};
    }
    if (request.type === "title") {
      this.handleTitleUpdate(request);
      return {};
    }
    return await this.handleHookRequest(request.payload);
  }

  private activeSubagentTool(active: AgyPeer): boolean {
    if (!active.currentStatus.startsWith("tool: ")) {
      return false;
    }
    return SUBAGENT_TRIGGER_TOOLS.has(active.currentStatus.slice("tool: ".length));
  }

  private async isSubagentConversation(conversationId: string): Promise<boolean> {
    if (this.subagentIds.has(conversationId)) {
      return true;
    }
    if (this.peers.has(conversationId)) {
      return false;
    }
    const active = this.activeMainId !== null ? this.peers.get(this.activeMainId) : undefined;
    if (!active || active.isIdle) {
      return false;
    }
    if (this.activeSubagentTool(active)) {
      this.subagentIds.add(conversationId);
      return true;
    }
    const creds = readWakeCredentials(active.conversationId);
    const lineage = creds ? await inspectConversationLineage(creds, conversationId) : undefined;
    if (lineage?.isSubagent === true) {
      this.subagentIds.add(conversationId);
      return true;
    }
    return false;
  }

  private retirePeer(conversationId: string): void {
    const existing = this.peers.get(conversationId);
    if (!existing) {
      return;
    }
    this.peers.delete(conversationId);
    if (this.activeMainId === conversationId) {
      this.activeMainId = null;
    }
    removeOwnedEndpoint(this.ownedIndexFiles.get(conversationId));
    this.ownedIndexFiles.delete(conversationId);
    void existing.close().catch(() => {
      // Ignore cleanup errors for retired peers.
    });
  }

  private publishIndex(conversationId: string): void {
    if (this.socketPath === null) {
      return;
    }
    try {
      const indexEndpoint = writeConversationIndex(conversationId, {
        socketPath: this.socketPath,
        lsPid: this.lsPid,
        mcpPid: process.pid,
      });
      if (indexEndpoint) {
        this.ownedIndexFiles.set(conversationId, indexEndpoint);
      }
    } catch {
      // Title index is best-effort.
    }
  }

  private ensureMainPeer(
    conversationId: string,
    initial: {
      readonly cwd?: string | undefined;
      readonly transcriptPath?: string | undefined;
      readonly modelName?: string | undefined;
      readonly title?: string | undefined;
    },
  ): AgyPeer {
    const existing = this.peers.get(conversationId);
    if (existing) {
      return existing;
    }
    if (this.activeMainId !== null && this.activeMainId !== conversationId) {
      const previous = this.peers.get(this.activeMainId);
      if (previous?.isIdle === true) {
        this.retirePeer(this.activeMainId);
      }
    }
    const peer = new AgyPeer(conversationId, this.config, {
      cwd: initial.cwd !== undefined && initial.cwd !== "" ? initial.cwd : process.cwd(),
      transcriptPath: initial.transcriptPath,
      modelName: initial.modelName,
      title: initial.title,
    });
    this.peers.set(conversationId, peer);
    this.activeMainId = conversationId;
    this.publishIndex(conversationId);
    peer.start();
    return peer;
  }

  private async handleHookRequest(payload: AgyHookInput): Promise<AgyHookResponse> {
    const convId = payload.conversationId;
    const isPreTool = payload.hookEventName === "PreToolUse";
    if (!isValidConversationId(convId)) {
      return isPreTool ? { decision: "allow" } : {};
    }
    if (await this.isSubagentConversation(convId)) {
      return isPreTool ? { decision: "allow" } : {};
    }
    const cwd =
      payload.cwd !== undefined && payload.cwd !== "" ? payload.cwd : payload.workspacePaths?.[0];
    const peer = this.ensureMainPeer(convId, {
      cwd,
      transcriptPath: payload.transcriptPath,
      modelName: payload.modelName,
    });
    const response = peer.onHookEvent(payload);
    if (payload.hookEventName === "SessionStart") {
      await peer.ensureConnected().catch(() => {
        // Reconnect timer will retry if broker startup is temporarily unavailable.
      });
    }
    return response;
  }

  private handleTitleUpdate(request: ControlTitleRequest): void {
    if (this.subagentIds.has(request.conversationId)) {
      return;
    }
    const peer = this.ensureMainPeer(request.conversationId, {
      cwd: request.cwd,
      transcriptPath: request.transcriptPath,
      modelName: request.modelName,
      title: request.title,
    });
    peer.updateTitle(request.title);
  }

  private resolveToolConversation(context: AgyToolCallContext): string | undefined {
    if (isValidConversationId(context.conversationId)) {
      return context.conversationId;
    }
    if (this.activeMainId !== null) {
      return this.activeMainId;
    }
    return this.peers.size === 1 ? this.peers.keys().next().value : undefined;
  }

  async executeTool(
    params: IntercomToolParams,
    context: AgyToolCallContext,
    signal: AbortSignal | undefined,
  ): Promise<ToolResultLike> {
    if (
      isValidConversationId(context.conversationId) &&
      isValidConversationId(context.rootConversationId) &&
      context.conversationId !== context.rootConversationId
    ) {
      this.subagentIds.add(context.conversationId);
      return toolError(
        "Intercom is available only to main agy sessions. Ask the main session to coordinate.",
      );
    }
    const conversationId = this.resolveToolConversation(context);
    if (conversationId === undefined) {
      return toolError("Could not determine Antigravity conversation ID for intercom.");
    }
    const peer = this.ensureMainPeer(conversationId, {
      transcriptPath: inferTranscriptPath(context.artifactsDir),
    });
    return await peer.executeTool(params, signal);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const peers = [...this.peers.values()];
    this.peers.clear();
    this.activeMainId = null;
    await Promise.allSettled(peers.map((peer) => peer.close()));
    const server = this.server;
    const ownedSocket = this.ownedSocket;
    this.server = null;
    this.ownedSocket = null;
    this.socketPath = null;
    if (server) {
      if (isOwnedEndpointCurrent(ownedSocket ?? undefined)) {
        removeOwnedEndpoint(ownedSocket ?? undefined);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      } else {
        // Unref instead of server.close(): Node's net.Server.close() unlinks Unix socket paths by name,
        // which would delete a successor server's socket inode.
        server.unref();
      }
    }
    for (const endpoint of this.ownedIndexFiles.values()) {
      removeOwnedEndpoint(endpoint);
    }
    this.ownedIndexFiles.clear();
  }
}
