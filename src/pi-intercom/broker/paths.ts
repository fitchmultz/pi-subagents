import { createHash } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { getPiAgentDir } from "../agent-dir.ts";

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getPiAgentDir(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
  }

  const digest = createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
  return join(tmpdir(), `pi-intercom-${digest}.sock`);
}
