import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import provider from "./agent-observe-provider.ts";

export default function fixture(pi: ExtensionAPI): void {
  provider(pi);
  const root = process.env.OBSERVE_TEST_ROOT;
  if (root === undefined) {
    throw new Error("OBSERVE_TEST_ROOT required");
  }
  const child = process.env.PI_INTERCOM_PARENT_SESSION_ID !== undefined;
  const publish = (kind: string, data: Readonly<Record<string, unknown>> = {}) => {
    fs.appendFileSync(
      path.join(root, "pty-events.jsonl"),
      JSON.stringify({ kind, child, pid: process.pid, at: Date.now(), ...data }) + "\n",
    );
  };
  const size = () => ({ columns: process.stdout.columns, rows: process.stdout.rows });
  const resize = () => publish("resize", size());
  let removeInput: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    publish("start", {
      mode: ctx.mode,
      stdinTTY: process.stdin.isTTY,
      stdoutTTY: process.stdout.isTTY,
      execPath: process.execPath,
      sdk: process.env.PI_PACKAGE_DIR,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      ...size(),
    });
    if (!child) {
      process.on("SIGWINCH", resize);
      removeInput = ctx.ui.onTerminalInput((data) => {
        publish("input", { base64: Buffer.from(data).toString("base64") });
      });
    }
  });
  pi.on("agent_start", () => publish("agent_start"));
  pi.on("ui_prompt_start", (event) => publish("ui_start", { promptKind: event.kind }));
  pi.on("ui_prompt_end", (event) => publish("ui_end", { promptKind: event.kind }));
  pi.on("agent_settled", (event) => publish("agent_settled", { aborted: event.aborted }));
  pi.on("context", (event) => {
    const last = event.messages.at(-1);
    publish("provider_context", {
      lastRole: last?.role,
      lastCustomType: last && "customType" in last ? last.customType : undefined,
    });
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      publish("assistant_end", { stopReason: event.message.stopReason });
    }
  });
  pi.on("session_shutdown", (event) => {
    publish("shutdown", { reason: event.reason });
    process.off("SIGWINCH", resize);
    removeInput?.();
  });
  if (!child) {
    pi.registerCommand("pty-proof-state", {
      description: "Record this isolated PTY fixture's native idle state without a model call",
      handler: (_args, ctx) => {
        publish("checkpoint", { idle: ctx.isIdle(), ...size() });
        return Promise.resolve();
      },
    });
  }
}
