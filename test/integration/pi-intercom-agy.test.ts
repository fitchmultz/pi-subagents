import "../support/isolated-home.ts";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { test as nodeTest, type TestContext } from "node:test";
import { promisify } from "node:util";
import { AgyBridgeHub } from "../../src/pi-intercom/agy/hub.ts";
import { agyPeerId, agyWakeDir, agyWakeFilePath } from "../../src/pi-intercom/agy/paths.ts";
import { IntercomClient } from "../../src/pi-intercom/broker/client.ts";
import { agyControlSocketPath } from "../../src/pi-intercom/broker/paths.ts";
import { RECIPIENT_TURN_FAILED_ATTACHMENT } from "../../src/pi-intercom/runtime-types.ts";
import type { Message, SessionInfo } from "../../src/pi-intercom/types.ts";
import { json, record, text } from "../support/assertions.ts";

const execFileAsync = promisify(execFile);

function isolatedAgent(t: TestContext): string {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(path.join(text(process.env.HOME), "agy-agent-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

async function waitFor<T>(
  predicate: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await delay(50);
  }
}

interface McpHarness {
  readonly proc: ChildProcess;
  readonly call: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly close: () => Promise<void>;
}

async function startMcpServer(t: TestContext): Promise<McpHarness> {
  const proc = spawn(process.execPath, ["src/pi-intercom/agy/mcp-server.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(proc, "exit");
  const pending = new Map<number, (msg: Readonly<Record<string, unknown>>) => void>();
  let nextId = 1;
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    if (line.trim() === "") {
      return;
    }
    const parsed = record(json(line));
    const id = parsed.id;
    if (typeof id === "number") {
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(parsed);
      }
    }
  });

  const call = (
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<Readonly<Record<string, unknown>>> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, 8000);
      timer.unref();
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const close = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.stdin.end();
      await exited;
    }
    rl.close();
  };
  t.after(close);

  // Wait until the control socket is published and MCP initialize responds.
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  await waitFor(() => (existsSync(agyControlSocketPath(process.pid)) ? true : undefined));
  return { proc, call, close };
}

async function runHook(
  payload: Readonly<Record<string, unknown>>,
  subcommand?: "title",
): Promise<Readonly<Record<string, unknown>>> {
  const args =
    subcommand !== undefined
      ? ["src/pi-intercom/agy/hook-cli.ts", subcommand]
      : ["src/pi-intercom/agy/hook-cli.ts"];
  const child = execFileAsync(process.execPath, args, {
    maxBuffer: 1024 * 1024,
  });
  child.child.stdin?.end(JSON.stringify(payload));
  const { stdout } = await child;
  return stdout.trim() === "" ? {} : record(json(stdout));
}

function mcpText(response: Readonly<Record<string, unknown>>): string {
  const result = record(response.result);
  const content = result.content;
  assert.ok(Array.isArray(content) && content.length > 0);
  return text(record(content[0]).text);
}

nodeTest(
  "agy MCP bridge supports bidirectional Intercom messaging, wake via agentapi, last, title sync, and clean exit",
  async (t) => {
    isolatedAgent(t);
    const workspace = mkdtempSync(path.join(text(process.env.HOME), "agy-ws-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));

    // Start real broker via a Pi peer client after MCP server boots (or let MCP spawn it).
    const mcp = await startMcpServer(t);
    const toolsList = await mcp.call("tools/list");
    const tools = record(toolsList.result).tools;
    assert.ok(Array.isArray(tools) && tools.length === 1);
    assert.equal(record(tools[0]).name, "intercom");

    const convId = "conv-main-11112222";
    const peerId = agyPeerId(convId);
    const transcriptPath = path.join(workspace, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Final agy analysis from transcript.",
      })}\n`,
    );

    // 1. SessionStart auto-registers agy on the broker (spawning broker if needed).
    const startResp = await runHook({
      hookEventName: "SessionStart",
      conversationId: convId,
      cwd: workspace,
      transcriptPath,
      modelName: "Gemini 4 Neon (Low)",
    });
    assert.deepEqual(startResp, {});

    // Connect a Pi peer and verify agy is discoverable.
    const piPeer = new IntercomClient();
    piPeer.on("error", () => {
      // Disconnects are handled in test teardown.
    });
    t.after(() => piPeer.disconnect());
    await piPeer.connect(
      {
        name: "pi-coordinator",
        cwd: workspace,
        model: "gpt-6.2",
        status: "idle",
        acceptsAsks: true,
      },
      "pi-coord-11112222",
    );

    const agySession = await waitFor(async () =>
      (await piPeer.listSessions()).find((session) => session.id === peerId),
    );
    assert.equal(agySession.model, "agy (Gemini 4 Neon (Low))");
    assert.equal(agySession.cwd, workspace);

    // 2. Title sync updates agy peer name, and claim updates workingOn.
    await runHook(
      { conversation_id: convId, conversation_title: "Auth Reviewer", cwd: workspace },
      "title",
    );
    await waitFor(async () => {
      const found = (await piPeer.listSessions()).find((s) => s.id === peerId);
      return found?.name === "Auth Reviewer" ? found : undefined;
    });

    const claimResp = await mcp.call("tools/call", {
      name: "intercom",
      arguments: { action: "claim", message: "Reviewing OAuth flow" },
      _meta: {
        "antigravity.google/conversation_id": convId,
        "antigravity.google/root_conversation_id": convId,
      },
    });
    assert.match(mcpText(claimResp), /Updated workingOn claim: Reviewing OAuth flow/);

    const listResp = await mcp.call("tools/call", {
      name: "intercom",
      arguments: { action: "list" },
      _meta: {
        "antigravity.google/conversation_id": convId,
        "antigravity.google/root_conversation_id": convId,
      },
    });
    assert.match(mcpText(listResp), /pi-coordinator/);
    assert.match(mcpText(listResp), /working_on:Reviewing OAuth flow/);

    // 3. Zero-turn last reads agy's transcript.jsonl directly.
    const lastResp = await piPeer.last(peerId);
    assert.ok(!("error" in lastResp));
    assert.equal(lastResp.entryId, "step-3");
    assert.equal(lastResp.text, "Final agy analysis from transcript.");

    // 4. Fallback hook delivery while active (before wake env exists).
    const activeMsg = await piPeer.send(peerId, { text: "Queued while active" });
    assert.equal(activeMsg.accepted, true);
    const stopResp = await waitFor(async () => {
      const resp = await runHook({
        hookEventName: "Stop",
        conversationId: convId,
        terminationReason: "NO_TOOL_CALL",
      });
      return resp.decision === "continue" ? resp : undefined;
    });
    assert.match(text(stopResp.reason), /Queued while active/);

    // Now finish the turn cleanly so agy becomes idle.
    const idleStop = await runHook({
      hookEventName: "Stop",
      conversationId: convId,
      terminationReason: "NO_TOOL_CALL",
    });
    assert.deepEqual(idleStop, {});

    // 5. Idle ask without wake credentials fails fast with RECIPIENT_TURN_FAILED_ATTACHMENT.
    const unwakeableReplies: Message[] = [];
    const onUnwakeable = (_from: SessionInfo, message: Message) => {
      unwakeableReplies.push(message);
    };
    piPeer.on("message", onUnwakeable);
    const unwakeableAsk = await piPeer.send(peerId, {
      text: "Are you awake?",
      expectsReply: true,
    });
    assert.equal(unwakeableAsk.accepted, true);
    const fastFail = await waitFor(() =>
      unwakeableReplies.find((msg) => msg.replyTo === unwakeableAsk.id),
    );
    piPeer.off("message", onUnwakeable);
    assert.equal(
      fastFail.content.attachments?.some((att) => att.name === RECIPIENT_TURN_FAILED_ATTACHMENT),
      true,
    );

    // 6. Install wake credentials with a fake agentapi executable and test idle wake + ask/reply.
    const wakeLog = path.join(workspace, "agentapi-calls.jsonl");
    const fakeAgy = path.join(workspace, "fake-agy.mjs");
    writeFileSync(
      fakeAgy,
      [
        `#!${process.execPath}`,
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(wakeLog)}, JSON.stringify({ argv: process.argv.slice(2), ls: process.env.ANTIGRAVITY_LS_ADDRESS, csrf: process.env.ANTIGRAVITY_CSRF_TOKEN }) + "\\n");`,
        'process.stdout.write(JSON.stringify({ response: { sendMessage: { ok: true } } }) + "\\n");',
      ].join("\n"),
    );
    chmodSync(fakeAgy, 0o755);
    mkdirSync(agyWakeDir(), { recursive: true, mode: 0o700 });
    const wakePath = agyWakeFilePath(convId);
    writeFileSync(
      wakePath,
      [
        "ANTIGRAVITY_LS_ADDRESS=localhost:54321",
        "ANTIGRAVITY_CSRF_TOKEN=secret-csrf-token",
        `ANTIGRAVITY_AGENTAPI_EXE=${fakeAgy}`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    const replies: Message[] = [];
    piPeer.on("message", (_from: SessionInfo, message: Message) => {
      replies.push(message);
    });
    const askSend = await piPeer.send(peerId, {
      text: "Check token rotation?",
      expectsReply: true,
    });
    assert.equal(askSend.accepted, true);

    const wakeCall = await waitFor(() => {
      if (!existsSync(wakeLog)) {
        return;
      }
      const lines = readFileSync(wakeLog, "utf8").trim().split("\n");
      return lines.length > 0 ? record(json(text(lines[0]))) : undefined;
    });
    assert.equal(wakeCall.ls, "localhost:54321");
    assert.equal(wakeCall.csrf, "secret-csrf-token");
    const argv = wakeCall.argv;
    assert.ok(Array.isArray(argv));
    assert.equal(argv[0], "agentapi");
    assert.equal(argv[1], "send-message");
    assert.equal(argv[3], convId);
    assert.match(text(argv[4]), /Check token rotation\?/);
    assert.match(text(argv[4]), new RegExp(askSend.id));

    // Agy answers the pending ask via MCP intercom(reply).
    const replyResp = await mcp.call("tools/call", {
      name: "intercom",
      arguments: { action: "reply", replyTo: askSend.id, message: "Token rotation looks good." },
      _meta: {
        "antigravity.google/conversation_id": convId,
        "antigravity.google/root_conversation_id": convId,
      },
    });
    assert.match(mcpText(replyResp), /Reply sent to pi-coordinator/);
    const receivedReply = await waitFor(() => replies.find((msg) => msg.replyTo === askSend.id));
    assert.equal(receivedReply.content.text, "Token rotation looks good.");

    // 7. Subagent MCP calls are rejected cleanly without registering a peer.
    const subagentResp = await mcp.call("tools/call", {
      name: "intercom",
      arguments: { action: "list" },
      _meta: {
        "antigravity.google/conversation_id": "conv-sub-99998888",
        "antigravity.google/root_conversation_id": convId,
      },
    });
    assert.equal(record(subagentResp.result).isError, true);
    assert.match(mcpText(subagentResp), /only to main agy sessions/);

    // 8. Closing MCP server unregisters agy, removes its socket, and preserves shell-owned wake file.
    await mcp.close();
    await waitFor(async () =>
      (await piPeer.listSessions()).some((session) => session.id === peerId) ? undefined : true,
    );
    assert.equal(existsSync(agyControlSocketPath(process.pid)), false);
    assert.equal(existsSync(wakePath), true);
  },
);

nodeTest(
  "AgyBridgeHub preserves an existing live control socket and only unlinks its own socket inode",
  async (t) => {
    isolatedAgent(t);
    const sharedLsPid = process.pid + 100_000;
    const hubA = new AgyBridgeHub(sharedLsPid);
    const hubB = new AgyBridgeHub(sharedLsPid);
    t.after(async () => {
      await hubB.close();
      await hubA.close();
    });

    const socketA = await hubA.start();
    assert.equal(socketA, agyControlSocketPath(sharedLsPid));

    // A second hub for the same Language Server must not steal or unlink the live socket.
    const socketB = await hubB.start();
    assert.equal(socketB, null);
    assert.equal(hubB.controlSocketPath, null);
    await hubB.close();

    // Hub A's control socket remains live and reachable after Hub B closes.
    assert.equal(existsSync(agyControlSocketPath(sharedLsPid)), true);
    const probe = net.createConnection(agyControlSocketPath(sharedLsPid));
    t.after(() => probe.destroy());
    await once(probe, "connect");
    probe.end();

    // If a successor binds a fresh inode at the path after an external replace, Hub A's close must not remove it.
    const successor = net.createServer();
    t.after(
      () =>
        new Promise<void>((resolve) => {
          successor.close(() => resolve());
        }),
    );
    rmSync(agyControlSocketPath(sharedLsPid), { force: true });
    await new Promise<void>((resolve, reject) => {
      successor.once("error", reject);
      successor.listen(agyControlSocketPath(sharedLsPid), () => resolve());
    });

    await hubA.close();
    assert.equal(existsSync(agyControlSocketPath(sharedLsPid)), true);
    const probeSuccessor = net.createConnection(agyControlSocketPath(sharedLsPid));
    t.after(() => probeSuccessor.destroy());
    await once(probeSuccessor, "connect");
    probeSuccessor.end();
  },
);
