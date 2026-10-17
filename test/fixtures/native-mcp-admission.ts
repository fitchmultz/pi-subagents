import * as fs from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  const receiptPath = process.env.MCP_ADMISSION_RECEIPT;
  if (receiptPath === undefined || receiptPath === "") {
    throw new Error("Missing admission receipt path");
  }
  const target = process.env.MCP_ADMISSION_TARGET;
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  const receipt: {
    active: string[];
    registered: { name: string; namespace?: string; owner: string }[];
    owners: string[];
    inputs: string[];
  } = { active: [], registered: [], owners: [], inputs: [] };
  const save = () =>
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({ ...receipt, providerCalls: faux.state.callCount }),
    );
  faux.setResponses([
    target !== undefined && target !== ""
      ? fauxAssistantMessage(fauxToolCall(target, { value: "receipt" }), { stopReason: "toolUse" })
      : fauxAssistantMessage("Ordinary standalone child"),
    fauxAssistantMessage("FOLLOWUP_DELIVERED"),
  ]);
  pi.registerProvider("faux", {
    api: faux.api,
    baseUrl: faux.getModel().baseUrl,
    apiKey: "synthetic-fixture",
    models: faux.models,
    streamSimple: (...args) => faux.provider.streamSimple(...args),
  });
  if (process.env.MCP_ADMISSION_COLLISION === "1") {
    pi.registerTool({
      name: "demo_echo",
      label: "Unrelated echo",
      description: "Collision from another owner",
      parameters: { type: "object" },
      execute: async () => {
        throw new Error("The underqualified child must not call a colliding tool");
      },
    });
  }
  pi.on("session_start", () => {
    if (process.env.MCP_ADMISSION_INACTIVE === "1") {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "demo_echo"));
    }
    receipt.active = pi.getActiveTools();
    receipt.registered = pi.getAllTools().map((tool) => ({
      name: tool.name,
      namespace: tool.namespace?.name,
      owner: tool.sourceInfo.path,
    }));
    receipt.owners = pi
      .getCommands()
      .filter((command) => command.name === "mcp")
      .map((command) => command.sourceInfo.path);
    save();
  });
  pi.on("input", (event) => {
    receipt.inputs.push(event.source);
  });
  let followedUp = false;
  pi.on("before_agent_start", () => {
    if (process.env.MCP_ADMISSION_FOLLOWUP === "1" && !followedUp) {
      followedUp = true;
      pi.setActiveTools([]);
      pi.sendUserMessage("Follow up after the admitted tool loadout changes", {
        deliverAs: "followUp",
      });
    }
  });
  pi.on("session_shutdown", save);
}
