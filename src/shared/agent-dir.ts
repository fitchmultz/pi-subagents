import * as os from "node:os";
import * as path from "node:path";

export function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") {
    return os.homedir();
  }
  if (configured?.startsWith("~/") === true) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return configured !== undefined && configured !== ""
    ? configured
    : path.join(os.homedir(), ".pi", "agent");
}
