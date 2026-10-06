import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

const sdk = pathToFileURL(join(process.env.PI_INTERCOM_TEST_SDK, "dist/index.js"));
const aiRoot = dirname(findPackageJSON("@earendil-works/pi-ai", sdk));
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(
  pathToFileURL(join(aiRoot, "dist/index.js")).href
);

export default function (pi) {
  const input = JSON.parse(readFileSync(process.env.PI_INTERCOM_LAUNCH_FIXTURE, "utf8"));
  const path = join(input.receipts, `${process.pid}.json`);
  const receipt = {
    pid: process.pid,
    ppid: process.ppid,
    cli: process.argv[1],
    sessionId: null,
    sessionFile: null,
    cwd: process.cwd(),
    calls: 0,
    networkRequests: 0,
    started: false,
    dialog: null,
    shutdown: false,
  };
  const save = () => writeFileSync(path, JSON.stringify(receipt));
  save();
  globalThis.fetch = async () => {
    receipt.networkRequests++;
    save();
    throw new Error("Network forbidden in launch fixture");
  };
  const faux = fauxProvider({
    provider: "launch-fixture",
    tokensPerSecond: 1_000_000,
    tokenSize: { min: 1024, max: 1024 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("intercom", { action: "reply", message: "native-launch-reply" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Reply sent."),
  ]);
  if (input.scenario === "early-work") {
    faux.setResponses([fauxAssistantMessage("Early activity observed.")]);
  }
  if (input.scenario === "large-result") {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("launch_payload", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall("intercom", { action: "reply", message: "native-launch-reply" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Reply sent."),
    ]);
  }
  pi.registerTool({
    name: "launch_payload",
    label: "Native payload fixture",
    description: "Produce a large native tool-result detail, not a synthetic RPC record.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "Large native detail retained." }],
      details: { payload: "LARGE_EVENT_SENTINEL" + "x".repeat(5 * 1024 * 1024) },
    }),
  });
  pi.registerProvider("launch-fixture", {
    api: faux.api,
    baseUrl: faux.getModel().baseUrl,
    apiKey: "fixture-key",
    models: faux.models,
    streamSimple: (...args) => {
      receipt.calls++;
      save();
      return faux.provider.streamSimple(...args);
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    receipt.sessionId = ctx.sessionManager.getSessionId();
    receipt.sessionFile = ctx.sessionManager.getSessionFile();
    receipt.started = true;
    save();
    if (input.scenario === "early-work") {
      setTimeout(() => pi.sendUserMessage("Locally configured startup activity fixture."), 250);
    }
    if (input.scenario === "stall") {
      const keepAlive = setInterval(save, 1000);
      process.once("exit", () => clearInterval(keepAlive));
      await new Promise(() => {
        // Deliberately stuck native startup exercises the real owner's cancellation deadline.
      });
    }
    if (input.scenario === "dialog") {
      receipt.dialog = await ctx.ui.confirm("Launch fixture", "No approval is permitted.");
      save();
    }
  });
  pi.on("session_shutdown", () => {
    receipt.shutdown = true;
    save();
  });
  process.once("exit", save);
}
