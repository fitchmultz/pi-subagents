import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_MCP_SELECTION_ENV } from "./child-route-env.ts";
import { formatToolName, resolveMcpDirectToolNames } from "./mcp-direct-tool-allowlist.ts";
import { errorMessage, isUnknownArray } from "../../shared/unknown.ts";

function requestedSelections(): readonly string[] {
  const parsed: unknown = JSON.parse(process.env[SUBAGENT_MCP_SELECTION_ENV] ?? "[]");
  if (!isUnknownArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Invalid child MCP selection");
  }
  return parsed;
}

function matchesCurrentSelection(tool: ToolInfo, selection: string): boolean {
  const [server = "", name = ""] = selection.replace(/\/+$/, "").split("/", 2);
  return (
    tool.namespace?.name === `mcp_${server}` &&
    (name === "" ||
      (["server", "none", "short", "mcp"] as const).some(
        (prefix) => tool.name === formatToolName(name, server, prefix),
      ))
  );
}

function unavailableSelections(pi: ExtensionAPI, selections: readonly string[], cwd: string) {
  const active = new Set(pi.getActiveTools());
  const owners = new Set(
    pi
      .getCommands()
      .filter((command) => command.source === "extension" && /^mcp(?::\d+)?$/.test(command.name))
      .map((command) => command.sourceInfo.path),
  );
  const owned = pi
    .getAllTools()
    .filter((tool) => active.has(tool.name) && owners.has(tool.sourceInfo.path));
  const legacy = owned.filter((tool) => tool.namespace === undefined);
  return selections.filter((selection) => {
    if (owned.some((tool) => matchesCurrentSelection(tool, selection))) {
      return false;
    }
    // Hints can admit older non-namespaced direct tools, not reserved gateways like mcp_search.
    return (
      legacy.length === 0 ||
      !resolveMcpDirectToolNames([selection], cwd).some((name) =>
        legacy.some((tool) => tool.name === name),
      )
    );
  });
}

/** Admit the launch once; later extension input may legitimately use a changed loadout. */
export function registerChildMcpAdmission(pi: ExtensionAPI): void {
  let admitted = false;
  pi.on("input", (_event, ctx) => {
    if (admitted) {
      return;
    }
    try {
      const selections = requestedSelections();
      const missing = selections.length === 0 ? [] : unavailableSelections(pi, selections, ctx.cwd);
      if (missing.length === 0) {
        admitted = true;
        return;
      }
      throw new Error(
        `${missing.map((selection) => `mcp:${selection}`).join(", ")}. ` +
          "Load pi-mcp-adapter in the child and check its server configuration and tool/extension exclusions. " +
          "Mixed native tool allowlists also need discoverable name hints before launch; warming stale metadata cannot fix unsupported configuration discovery. " +
          "For native Pi MCP, exclude pi-mcp-adapter from the child and use the registered mcp__server__tool name instead.",
      );
    } catch (error) {
      console.error(`Subagent MCP selection unavailable: ${errorMessage(error)}`);
      process.exitCode = 1;
      // Native event throws are swallowed. Handled input stops dispatch and permits normal shutdown.
      return { action: "handled" };
    }
  });
}
